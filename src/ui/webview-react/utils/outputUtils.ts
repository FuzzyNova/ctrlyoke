/**
 * Output rendering utilities
 * Migrated from output-manager.js
 */
import * as Diff from "diff";
import type { DiffHunk } from "../types/cliEvents";
import { escapeHtml, truncate } from "./string";
import { formatTime, getTimestamp } from "./time";

// Re-export these for convenience in output components
export { escapeHtml, truncate, formatTime, getTimestamp };

/**
 * Shorten file path for display
 */
export function shortenPath(
  filePath: string | undefined,
  maxLen: number = 50
): string {
  if (!filePath || filePath.length <= maxLen) return filePath || "";

  const parts = filePath.split(/[/\\]/);
  if (parts.length <= 2) return filePath;

  // Show "...parent/file.ext"
  return "..." + parts.slice(-2).join("/");
}

/**
 * Format timestamp as time string (HH:MM:SS format)
 */
export function formatTimeHMS(timestampMs: number): string {
  const date = new Date(timestampMs);
  return date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

/**
 * Extract key parameters from tool call for display
 */
export function extractKeyParameters(
  toolName: string,
  parameters?: Record<string, unknown>
): string {
  if (!parameters) return "";

  const lowerName = toolName.toLowerCase();

  // Bash/Shell commands
  if (lowerName === "bash" || lowerName === "shell") {
    return truncate(parameters.command as string, 80);
  }

  // File operations
  if (lowerName === "write" || lowerName === "edit" || lowerName === "read") {
    return shortenPath(parameters.file_path as string);
  }

  // MultiEdit
  if (lowerName === "multiedit") {
    const fileCount = Array.isArray(parameters.files)
      ? parameters.files.length
      : 1;
    return `${fileCount} file${fileCount !== 1 ? "s" : ""}`;
  }

  // Glob
  if (lowerName === "glob") {
    return (parameters.pattern as string) || "";
  }

  // Grep/Search
  if (lowerName === "grep" || lowerName === "search") {
    const pattern = parameters.pattern
      ? `"${truncate(parameters.pattern as string, 40)}"`
      : "";
    const path = parameters.path
      ? `, path: ${shortenPath(parameters.path as string)}`
      : "";
    return `${pattern}${path}`;
  }

  // Task
  if (lowerName === "task") {
    return truncate(
      (parameters.description as string) || (parameters.prompt as string) || "",
      60
    );
  }

  // Default: show first 2-3 key parameters
  const keys = Object.keys(parameters).slice(0, 3);
  return keys
    .map((k) => `${k}: ${truncate(String(parameters[k]), 30)}`)
    .join(", ");
}

/**
 * Line in a diff output
 */
export interface DiffLine {
  type: "added" | "removed" | "context";
  oldLineNum?: number;
  newLineNum?: number;
  content: string;
}

/**
 * Parse unified diff hunks into DiffLine array
 */
export function parseUnifiedDiff(hunks: DiffHunk[]): DiffLine[] {
  const lines: DiffLine[] = [];

  hunks.forEach((hunk) => {
    let oldLineNum = hunk.oldStart;
    let newLineNum = hunk.newStart;

    hunk.lines.forEach((line) => {
      const prefix = line[0];
      const content = line.slice(1); // Remove prefix character

      if (prefix === "+") {
        // Added line
        lines.push({
          type: "added",
          newLineNum: newLineNum,
          content,
        });
        newLineNum++;
      } else if (prefix === "-") {
        // Removed line
        lines.push({
          type: "removed",
          oldLineNum: oldLineNum,
          content,
        });
        oldLineNum++;
      } else {
        // Context line (space prefix)
        lines.push({
          type: "context",
          oldLineNum: oldLineNum,
          newLineNum: newLineNum,
          content,
        });
        oldLineNum++;
        newLineNum++;
      }
    });
  });

  return lines;
}

/**
 * Generate diff lines from old/new content using diff library
 */
export function generateDiffLines(
  oldContent: string,
  newContent: string
): DiffLine[] {
  const diffResult = Diff.diffLines(oldContent, newContent);
  const lines: DiffLine[] = [];

  let oldLineNum = 1;
  let newLineNum = 1;

  diffResult.forEach((part) => {
    const partLines = part.value.split("\n");
    // Remove trailing empty string from split
    if (partLines[partLines.length - 1] === "") {
      partLines.pop();
    }

    partLines.forEach((line) => {
      if (part.added) {
        lines.push({
          type: "added",
          newLineNum: newLineNum,
          content: line,
        });
        newLineNum++;
      } else if (part.removed) {
        lines.push({
          type: "removed",
          oldLineNum: oldLineNum,
          content: line,
        });
        oldLineNum++;
      } else {
        lines.push({
          type: "context",
          oldLineNum: oldLineNum,
          newLineNum: newLineNum,
          content: line,
        });
        oldLineNum++;
        newLineNum++;
      }
    });
  });

  return lines;
}

/**
 * Generate markdown export content from CLI outputs
 */
export function generateMarkdownExport(
  outputs: Array<{
    type: "status" | "cli";
    stepIndex: number;
    timestamp: number;
    data: unknown;
    attemptIndex?: number;
  }>,
  metadata: {
    fileName: string;
    executionState: string;
    currentStep: number;
    totalSteps: number;
  }
): string {
  const lines: string[] = [];
  const timestamp = new Date().toISOString();

  // Header
  lines.push("# FlightPath Execution Output");
  lines.push("");
  lines.push(`**File:** ${metadata.fileName || "Unknown"}`);
  lines.push(`**Exported:** ${timestamp}`);
  lines.push(`**Status:** ${metadata.executionState}`);
  lines.push(
    `**Progress:** ${metadata.currentStep} of ${metadata.totalSteps} completed`
  );
  lines.push("");
  lines.push("---");
  lines.push("");

  if (outputs.length === 0) {
    lines.push("*No output captured*");
    return lines.join("\n");
  }

  // Sort by timestamp for chronological order
  const sortedOutputs = [...outputs].sort((a, b) => a.timestamp - b.timestamp);

  sortedOutputs.forEach((item) => {
    if (item.type === "status") {
      const statusMsg = item.data as {
        message: string;
        timestamp: string;
      };
      lines.push(`> **[${statusMsg.timestamp}]** ${statusMsg.message}`);
      lines.push("");
    } else if (item.type === "cli") {
      const output = item.data as {
        prompt?: string;
        response?: string;
        cliCommand?: string;
        workingDirectory?: string;
        tokens?: { prompt: number; completion: number };
        elapsed?: number;
        structured?: { events: Array<{ type: string; data: unknown }> };
      };
      const attemptLabel =
        item.attemptIndex === 0
          ? "Initial Attempt"
          : `Retry ${item.attemptIndex}`;

      lines.push(`## Prompt ${item.stepIndex + 1} - ${attemptLabel}`);
      lines.push("");

      if (output.prompt) {
        lines.push("### Prompt");
        lines.push("");
        lines.push("```");
        lines.push(output.prompt);
        lines.push("```");
        lines.push("");
      }

      if (output.cliCommand) {
        lines.push("### CLI Command");
        lines.push("");
        lines.push("```bash");
        const workingDir = output.workingDirectory || "workspace";
        lines.push(`${workingDir}> ${output.cliCommand}`);
        lines.push("```");
        lines.push("");
      }

      if (output.response) {
        lines.push("### Response");
        lines.push("");
        lines.push("```");
        lines.push(output.response);
        lines.push("```");
        lines.push("");
      }

      // Stats section
      const stats: string[] = [];
      if (output.tokens) {
        const total = output.tokens.prompt + output.tokens.completion;
        stats.push(
          `Tokens: ${output.tokens.prompt} prompt / ${output.tokens.completion} completion / ${total} total`
        );
      }
      if (output.elapsed !== undefined) {
        stats.push(`${output.elapsed}s`);
      }

      if (stats.length > 0) {
        lines.push(`*${stats.join(" | ")}*`);
        lines.push("");
      }

      lines.push("---");
      lines.push("");
    }
  });

  return lines.join("\n");
}
