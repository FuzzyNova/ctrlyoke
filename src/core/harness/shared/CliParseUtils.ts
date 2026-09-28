import { Log } from "../../../utils/Log";
import { splitLines } from "../../../utils/TextLines";
import { UnifiedDiffHunk } from "../../../types/CliOutputTypes";

/**
 * Shared response parsing utilities for CLI integrations
 *
 * Supports:
 * - Stream-json format (Claude CLI - concatenated JSON objects)
 * - JSONL format (Codex CLI - newline-delimited JSON)
 * - Text format (Copilot CLI - plain text with statistics)
 */
export class CliParseUtils {
  /**
   * Extract JSON objects from a concatenated stream (stream-json format)
   *
   * Claude CLI outputs concatenated JSON objects without newlines:
   * {"type":"system",...}{"type":"assistant",...}{"type":"result",...}
   *
   * @param data Stream data containing JSON objects
   * @returns Parsed objects and remainder for next chunk
   */
  static extractJsonObjectsFromStream(data: string): {
    objects: any[];
    remainder: string;
  } {
    const objects: any[] = [];
    let cursor = 0;

    while (cursor < data.length) {
      const objStart = data.indexOf("{", cursor);
      if (objStart === -1) {
        cursor = data.length;
        break;
      }

      let depth = 0;
      let inString = false;
      let escape = false;
      let objEnd = -1;

      for (let i = objStart; i < data.length; i++) {
        const char = data[i];

        if (escape) {
          escape = false;
          continue;
        }

        if (char === "\\") {
          escape = true;
          continue;
        }

        if (char === '"') {
          inString = !inString;
          continue;
        }

        if (!inString) {
          if (char === "{") {
            depth++;
          } else if (char === "}") {
            depth--;
            if (depth === 0) {
              objEnd = i + 1;
              break;
            }
          }
        }
      }

      if (objEnd !== -1) {
        const objStr = data.substring(objStart, objEnd);
        try {
          const json = JSON.parse(objStr);
          objects.push(json);
        } catch (parseError) {
          Log.trace(
            `[CliParseUtils] Failed to parse stream-json object: ${objStr.substring(0, 100)}`
          );
        }
        cursor = objEnd;
        continue;
      }

      cursor = objStart;
      break;
    }

    return {
      objects,
      remainder: data.substring(cursor),
    };
  }

  /**
   * Parse JSONL (newline-delimited JSON) format
   *
   * Codex CLI outputs JSONL events:
   * {"type":"thread.started",...}
   * {"type":"item.completed",...}
   * {"type":"turn.completed",...}
   *
   * @param data JSONL data with newline-delimited JSON objects
   * @returns Parsed objects array
   */
  static parseJsonLines(data: string): any[] {
    const objects: any[] = [];
    const lines = splitLines(data);

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const json = JSON.parse(line);
        objects.push(json);
      } catch (parseError) {
        Log.trace(
          `[CliParseUtils] Skipping non-JSON line: ${line.substring(0, 100)}`
        );
      }
    }

    return objects;
  }

  /**
   * Parse unified diff format into structured patch hunks
   *
   * Extracts hunk headers and diff lines from Git-style unified diff output.
   * Shared across all harnesses that receive `detailedContent` diffs (e.g. Copilot CLI).
   *
   * @param diffText - Unified diff string (e.g. from tool.execution_complete detailedContent)
   * @returns Array of diff hunks, or undefined if no hunks found
   */
  static parseUnifiedDiff(diffText: string): UnifiedDiffHunk[] | undefined {
    if (!diffText) {
      return undefined;
    }

    const hunks: UnifiedDiffHunk[] = [];
    const lines = diffText.split("\n");
    let currentHunk: UnifiedDiffHunk | null = null;

    for (const line of lines) {
      const hunkMatch = line.match(
        /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
      );
      if (hunkMatch) {
        if (currentHunk) {
          hunks.push(currentHunk);
        }
        currentHunk = {
          oldStart: parseInt(hunkMatch[1], 10),
          oldLines: hunkMatch[2] ? parseInt(hunkMatch[2], 10) : 1,
          newStart: parseInt(hunkMatch[3], 10),
          newLines: hunkMatch[4] ? parseInt(hunkMatch[4], 10) : 1,
          lines: [],
        };
        continue;
      }

      if (currentHunk) {
        if (
          line.startsWith(" ") ||
          line.startsWith("-") ||
          line.startsWith("+")
        ) {
          currentHunk.lines.push(line);
        } else if (line.startsWith("diff ") || line.startsWith("index ")) {
          hunks.push(currentHunk);
          currentHunk = null;
        }
      }
    }

    if (currentHunk) {
      hunks.push(currentHunk);
    }

    return hunks.length > 0 ? hunks : undefined;
  }

  // Harness-specific parsing methods moved to:
  // - CopilotResponseParser.parseCopilotText()
  // - ClaudeCliProvider.parseHeadlessStdout()
  // - CodexLogParser.extractResponse()
}
