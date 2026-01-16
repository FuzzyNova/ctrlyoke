import { CopilotCliResult } from "../../../types/CopilotTypes";
import { Log } from "../../../utils/Log";

/**
 * Generic CLI response structure (normalized across all CLIs)
 */
export interface CliJsonResponse {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  response?: string;
  content?: string;
  usage?: CliUsage;
  session_id?: string;
  thread_id?: string;
  model?: string;
  error?: string;
  duration_ms?: number;
}

/**
 * Generic usage statistics structure
 */
export interface CliUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens?: number;
}

/**
 * Shared response parsing utilities for CLI integrations
 *
 * Supports:
 * - Stream-json format (Claude CLI - concatenated JSON objects)
 * - JSONL format (Codex CLI - newline-delimited JSON)
 * - Text format (Copilot CLI - plain text with statistics)
 */
export class CliResponseParser {
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
          Log.debug(
            `Failed to parse stream-json object: ${objStr.substring(0, 100)}`
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
    const lines = data.split("\n");

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const json = JSON.parse(line);
        objects.push(json);
      } catch (parseError) {
        Log.debug(`Skipping non-JSON line: ${line.substring(0, 100)}`);
      }
    }

    return objects;
  }

  /**
   * Extract usage statistics from various JSON formats
   *
   * @param json JSON object with usage field
   * @returns Normalized usage statistics
   */
  static extractUsageStats(json: any): CliUsage | undefined {
    if (!json.usage) {
      return undefined;
    }

    const { input_tokens, output_tokens } = json.usage;
    return {
      input_tokens,
      output_tokens,
      total_tokens: json.usage.total_tokens || input_tokens + output_tokens,
    };
  }

  /**
   * Extract session ID from various JSON formats
   *
   * Different CLIs use different field names:
   * - Claude: session_id
   * - Codex: thread_id
   * - Copilot: session (from logs, not JSON)
   *
   * @param json JSON object or text output
   * @returns Session ID if found
   */
  static extractSessionId(json: any): string | undefined {
    return json.session_id || json.thread_id;
  }

  /**
   * Format usage statistics as a human-readable string
   *
   * @param usage Usage statistics object
   * @param model Optional model name to include
   * @returns Formatted string like "Usage: 1234 input + 5678 output = 6912 tokens | Model: claude-sonnet-4.5"
   */
  static formatStatistics(usage: CliUsage | undefined, model?: string): string {
    if (!usage) {
      return "";
    }

    const { input_tokens, output_tokens, total_tokens } = usage;
    const total = total_tokens || input_tokens + output_tokens;
    let stats = `Usage: ${input_tokens} input + ${output_tokens} output = ${total} tokens`;

    if (model) {
      stats += ` | Model: ${model}`;
    }

    return stats;
  }

  // Provider-specific parsing methods moved to:
  // - CopilotResponseParser.parseCopilotText()
  // - ClaudeResponseParser.parseClaudeStreamJson()
  // - CodexResponseParser.parseCodexJsonLines()
}
