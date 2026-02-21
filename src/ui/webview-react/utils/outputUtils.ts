/**
 * Output rendering utilities
 * Migrated from output-manager.js
 */
import * as Diff from "diff";
import type {
  DiffHunk,
  CliEvent,
  BashCommandEventData,
  FileEditEventData,
  FileWriteEventData,
  FileReadEventData,
  FileDeleteEventData,
  McpToolCallEventData,
  WebSearchEventData,
  ToolCallEventData,
  ToolResultEventData,
  TextEventData,
  ThinkingEventData,
} from "../types/cliEvents";
import { CLI_EVENT_TYPES, OPERATION_STATUS } from "../types/cliEvents";
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
 * Format tool call in terminal style for markdown export
 */
function formatToolCallForMarkdown(
  toolName: string,
  parameters?: Record<string, unknown>
): string {
  const params = extractKeyParameters(toolName, parameters);
  return `● ${toolName}(${params})`;
}

/**
 * Format tool result for markdown export
 */
function formatToolResultForMarkdown(result: {
  success: boolean;
  output?: string;
  error?: string;
}): string {
  const prefix = "  ⎿  ";
  if (!result.success && result.error) {
    return prefix + truncate(result.error, 200);
  }
  if (result.output) {
    return prefix + truncate(result.output, 100);
  }
  return prefix + (result.success ? "Success" : "Failed");
}

/**
 * Format structured patch hunks as markdown diff lines
 */
function formatStructuredPatchForMarkdown(hunks: DiffHunk[]): string[] {
  const diffLines: string[] = [];

  hunks.forEach((hunk) => {
    let oldLineNum = hunk.oldStart;
    let newLineNum = hunk.newStart;

    hunk.lines.forEach((line) => {
      const prefix = line[0];
      const content = line.slice(1);

      if (prefix === "+") {
        diffLines.push(`+${String(newLineNum).padStart(4)} | ${content}`);
        newLineNum++;
      } else if (prefix === "-") {
        diffLines.push(`-${String(oldLineNum).padStart(4)} | ${content}`);
        oldLineNum++;
      } else {
        diffLines.push(` ${String(oldLineNum).padStart(4)} | ${content}`);
        oldLineNum++;
        newLineNum++;
      }
    });
  });

  return diffLines;
}

/**
 * Format diff for markdown export from old/new content
 */
function formatDiffForMarkdown(
  oldContent: string,
  newContent: string,
  structuredPatch?: DiffHunk[]
): string[] {
  // Prefer structured patch with accurate line numbers
  if (structuredPatch && structuredPatch.length > 0) {
    return formatStructuredPatchForMarkdown(structuredPatch);
  }

  // Fallback: generate from content
  const diffLines = generateDiffLines(oldContent, newContent);
  return diffLines.map((line) => {
    const num =
      line.type === "added"
        ? String(line.newLineNum ?? "").padStart(4)
        : String(line.oldLineNum ?? "").padStart(4);
    const prefix =
      line.type === "added" ? "+" : line.type === "removed" ? "-" : " ";
    return `${prefix}${num} | ${line.content}`;
  });
}

/**
 * Render structured CLI events to markdown lines (mirrors old output-manager.js generateMarkdownOutput)
 */
function renderStructuredEventsToMarkdown(
  events: CliEvent[],
  lines: string[]
): void {
  for (const event of events) {
    switch (event.type) {
      case CLI_EVENT_TYPES.TEXT: {
        const data = event.data as TextEventData;
        if (data.text) {
          lines.push(data.text);
          lines.push("");
        }
        break;
      }

      case CLI_EVENT_TYPES.BASH_COMMAND: {
        const data = event.data as BashCommandEventData;
        lines.push(`● ${data.command}`);

        if (data.status !== OPERATION_STATUS.INITIATED) {
          if (data.output) {
            lines.push("");
            lines.push("  ⎿  Output:");
            lines.push("```");
            lines.push(data.output.trim());
            lines.push("```");
          }

          if (data.error) {
            lines.push("");
            lines.push("  ⎿  Error:");
            lines.push("```");
            lines.push(data.error.trim());
            lines.push("```");
          }

          if (
            data.status === OPERATION_STATUS.COMPLETED ||
            data.status === OPERATION_STATUS.FAILED
          ) {
            const exitCode =
              data.exitCode !== undefined ? data.exitCode : "?";
            lines.push("");
            lines.push(`  ⎿  (exit: ${exitCode})`);
          }
        }

        lines.push("");
        break;
      }

      case CLI_EVENT_TYPES.FILE_EDIT: {
        const data = event.data as FileEditEventData;
        if (data.path) {
          if (data.status === OPERATION_STATUS.INITIATED) {
            lines.push(`● Editing ${data.path}`);
          } else if (data.status === OPERATION_STATUS.FAILED) {
            lines.push(`● Edit failed: ${data.path}`);
            if (data.error) {
              lines.push(`  Error: ${data.error}`);
            }
          } else {
            lines.push(`● Edited ${data.path}`);
          }

          // Render diff for completed edits
          if (
            data.status !== OPERATION_STATUS.INITIATED &&
            (data.structuredPatch ||
              (data.oldContent && data.newContent))
          ) {
            lines.push("");
            lines.push("```diff");
            const diffLines = formatDiffForMarkdown(
              data.oldContent || "",
              data.newContent || "",
              data.structuredPatch
            );
            diffLines.forEach((line) => lines.push(line));
            lines.push("```");
          }
          lines.push("");
        }
        break;
      }

      case CLI_EVENT_TYPES.FILE_WRITE: {
        const data = event.data as FileWriteEventData;
        if (data.status === OPERATION_STATUS.INITIATED) {
          lines.push(`● Writing ${data.path} (starting...)`);
        } else if (data.status === OPERATION_STATUS.FAILED) {
          lines.push(`● Write failed: ${data.path}`);
          if (data.error) {
            lines.push(`  Error: ${data.error}`);
          }
        } else {
          lines.push(`● Wrote ${data.path}`);
          if (data.content) {
            lines.push(` (${data.content.length} bytes)`);
          }
        }
        lines.push("");
        break;
      }

      case CLI_EVENT_TYPES.FILE_READ: {
        const data = event.data as FileReadEventData;
        if (data.status === OPERATION_STATUS.INITIATED) {
          lines.push(`● Reading ${data.path} (starting...)`);
        } else if (data.status === OPERATION_STATUS.FAILED) {
          lines.push(`● Read failed: ${data.path}`);
          if (data.error) {
            lines.push(`  Error: ${data.error}`);
          }
        } else {
          lines.push(`● Read ${data.path}`);
        }
        lines.push("");
        break;
      }

      case CLI_EVENT_TYPES.FILE_DELETE: {
        const data = event.data as FileDeleteEventData;
        lines.push(`● Delete file: ${data.path}`);
        lines.push("");
        break;
      }

      case CLI_EVENT_TYPES.MCP_TOOL_CALL: {
        const data = event.data as McpToolCallEventData;
        lines.push(`● MCP: ${data.server}.${data.tool}`);
        lines.push("");
        break;
      }

      case CLI_EVENT_TYPES.WEB_SEARCH: {
        const data = event.data as WebSearchEventData;
        lines.push(`● Web search: "${data.query}"`);
        lines.push("");
        break;
      }

      case CLI_EVENT_TYPES.TOOL_CALL: {
        const data = event.data as ToolCallEventData;
        const toolLine = formatToolCallForMarkdown(
          data.name,
          data.parameters
        );
        lines.push(toolLine);

        if (data.result) {
          const resultLine = formatToolResultForMarkdown(data.result);
          lines.push(resultLine);
        }
        lines.push("");
        break;
      }

      case CLI_EVENT_TYPES.THINKING: {
        const data = event.data as ThinkingEventData;
        if (data.text) {
          const label =
            data.label && data.label !== "Thinking"
              ? data.label
              : "Thinking";
          lines.push(`● ${label}: ${data.text}`);
          lines.push("");
        }
        break;
      }

      case CLI_EVENT_TYPES.TOOL_RESULT: {
        const data = event.data as ToolResultEventData;
        if (data.result) {
          const resultLine = formatToolResultForMarkdown(data.result);
          lines.push(resultLine);
          lines.push("");
        }
        break;
      }
    }
  }
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
        tokens?: { prompt: number; completion: number; cached?: number; contextWindowUsed?: number; contextWindowSize?: number };
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

      // Export events in chronological order (structured) or fall back to plain response
      if (
        output.structured?.events &&
        output.structured.events.length > 0
      ) {
        lines.push("### Response");
        lines.push("");
        renderStructuredEventsToMarkdown(
          output.structured.events as CliEvent[],
          lines
        );
      } else if (output.response) {
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
        const { prompt, completion, cached, contextWindowUsed, contextWindowSize } = output.tokens;
        if (contextWindowUsed !== undefined && contextWindowSize) {
          const fmt = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
          const pct = Math.round((contextWindowUsed / contextWindowSize) * 100);
          stats.push(`Context: ${fmt(contextWindowUsed)}/${fmt(contextWindowSize)} (${pct}%)`);
        }
        const total = prompt + completion;
        const cachedSuffix = cached ? ` / ${cached} cached` : "";
        stats.push(`Tokens: ${prompt} in / ${completion} out / ${total} total${cachedSuffix}`);
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
