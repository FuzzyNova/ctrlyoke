/**
 * Markdown export utilities.
 *
 * Converts CLI output history (structured events + status messages) into a
 * human-readable markdown document suitable for saving or sharing.
 */
import type {
  UnifiedDiffHunk,
  CliEvent,
  BashCommandData,
  FileEditData,
  FileWriteData,
  FileReadData,
  FileDeleteData,
  McpToolCallData,
  WebSearchData,
  ToolCall,
  ToolResultData,
  TextData,
  ThinkingBlock,
} from "../types/cliEvents";
import type { OrderedHistoryEntry } from "@root/types/OutputHistoryTypes";
import { CLI_EVENT_TYPES, OPERATION_STATUS } from "../types/cliEvents";
import {
  HARNESS_INFO,
  FINAL_STEP_PHASES,
  type FinalStepPhase,
} from "../types/messages";
import { mapOrderedHistoryEntriesToMessages } from "./outputProjection";
import { truncate } from "./string";
import { generateDiffLines } from "./diffUtils";
import { extractKeyParameters, getFirstWords } from "./outputUtils";

// ── Private helpers ────────────────────────────────────────────────────────────

interface MarkdownExportItem {
  type: "status" | "cli";
  target: {
    kind: FinalStepPhase;
    index: number;
  };
  timestamp: number;
  sequence?: number;
  data: unknown;
  attemptIndex?: number;
  /** User-defined step name (undefined when none set) */
  stepName?: string;
}

function formatToolCallForMarkdown(
  toolName: string,
  parameters?: Record<string, unknown>
): string {
  const params = extractKeyParameters(toolName, parameters);
  return `● ${toolName}(${params})`;
}

function formatToolResultForMarkdown(result: {
  success: boolean;
  output?: string;
  error?: string;
}): string {
  const prefix = "  ⎿  ";
  if (!result.success && result.error)
    return prefix + truncate(result.error, 200);
  if (result.output) return prefix + truncate(result.output, 100);
  return prefix + (result.success ? "Success" : "Failed");
}

function formatStructuredPatchForMarkdown(hunks: UnifiedDiffHunk[]): string[] {
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

function formatDiffForMarkdown(
  oldContent: string,
  newContent: string,
  structuredPatch?: UnifiedDiffHunk[]
): string[] {
  if (structuredPatch && structuredPatch.length > 0) {
    return formatStructuredPatchForMarkdown(structuredPatch);
  }

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

function renderStructuredEventsToMarkdown(
  events: CliEvent[],
  lines: string[]
): void {
  for (const event of events) {
    switch (event.type) {
      case CLI_EVENT_TYPES.TEXT: {
        const data = event.data as TextData;
        if (data.text) {
          lines.push(data.text);
          lines.push("");
        }
        break;
      }

      case CLI_EVENT_TYPES.BASH_COMMAND: {
        const data = event.data as BashCommandData;
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
            const exitCode = data.exitCode !== undefined ? data.exitCode : "?";
            lines.push("");
            lines.push(`  ⎿  (exit: ${exitCode})`);
          }
        }

        lines.push("");
        break;
      }

      case CLI_EVENT_TYPES.FILE_EDIT: {
        const data = event.data as FileEditData;
        if (data.path) {
          if (data.status === OPERATION_STATUS.INITIATED) {
            lines.push(`● Editing ${data.path}`);
          } else if (data.status === OPERATION_STATUS.FAILED) {
            lines.push(`● Edit failed: ${data.path}`);
            if (data.error) lines.push(`  Error: ${data.error}`);
          } else {
            lines.push(`● Edited ${data.path}`);
          }

          if (
            data.status !== OPERATION_STATUS.INITIATED &&
            (data.structuredPatch || (data.oldContent && data.newContent))
          ) {
            lines.push("");
            lines.push("```diff");
            const dl = formatDiffForMarkdown(
              data.oldContent || "",
              data.newContent || "",
              data.structuredPatch
            );
            dl.forEach((l) => lines.push(l));
            lines.push("```");
          }
          lines.push("");
        }
        break;
      }

      case CLI_EVENT_TYPES.FILE_WRITE: {
        const data = event.data as FileWriteData;
        if (data.status === OPERATION_STATUS.INITIATED) {
          lines.push(`● Writing ${data.path} (starting...)`);
        } else if (data.status === OPERATION_STATUS.FAILED) {
          lines.push(`● Write failed: ${data.path}`);
          if (data.error) lines.push(`  Error: ${data.error}`);
        } else {
          lines.push(
            `● Wrote ${data.path}${data.content ? ` (${data.content.length} bytes)` : ""}`
          );
        }
        lines.push("");
        break;
      }

      case CLI_EVENT_TYPES.FILE_READ: {
        const data = event.data as FileReadData;
        if (data.status === OPERATION_STATUS.INITIATED) {
          lines.push(`● Reading ${data.path} (starting...)`);
        } else if (data.status === OPERATION_STATUS.FAILED) {
          lines.push(`● Read failed: ${data.path}`);
          if (data.error) lines.push(`  Error: ${data.error}`);
        } else {
          lines.push(`● Read ${data.path}`);
        }
        lines.push("");
        break;
      }

      case CLI_EVENT_TYPES.FILE_DELETE: {
        const data = event.data as FileDeleteData;
        lines.push(`● Delete file: ${data.path}`);
        lines.push("");
        break;
      }

      case CLI_EVENT_TYPES.MCP_TOOL_CALL: {
        const data = event.data as McpToolCallData;
        lines.push(`● MCP: ${data.server}.${data.tool}`);
        lines.push("");
        break;
      }

      case CLI_EVENT_TYPES.WEB_SEARCH: {
        const data = event.data as WebSearchData;
        lines.push(`● Web search: "${data.query}"`);
        lines.push("");
        break;
      }

      case CLI_EVENT_TYPES.TOOL_CALL: {
        const data = event.data as ToolCall;
        lines.push(formatToolCallForMarkdown(data.name, data.parameters));
        if (data.result) lines.push(formatToolResultForMarkdown(data.result));
        lines.push("");
        break;
      }

      case CLI_EVENT_TYPES.THINKING: {
        const data = event.data as ThinkingBlock;
        if (data.text) {
          const label =
            data.label && data.label !== "Thinking" ? data.label : "Thinking";
          lines.push(`● ${label}: ${data.text}`);
          lines.push("");
        }
        break;
      }

      case CLI_EVENT_TYPES.TOOL_RESULT: {
        const data = event.data as ToolResultData;
        if (data.result) {
          lines.push(formatToolResultForMarkdown(data.result));
          lines.push("");
        }
        break;
      }
    }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Generate markdown export content from CLI outputs.
 */
export function generateMarkdownExport(
  outputs: ReadonlyArray<MarkdownExportItem>,
  metadata: {
    fileName: string;
    executionState: string;
    currentStep: number;
    totalSteps: number;
  },
  options?: {
    orderedEntries?: ReadonlyArray<OrderedHistoryEntry>;
  }
): string {
  const lines: string[] = [];
  const timestamp = new Date().toISOString();

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

  const sortedOutputs: MarkdownExportItem[] =
    options?.orderedEntries && options.orderedEntries.length > 0
      ? (mapOrderedHistoryEntriesToMessages(
          options.orderedEntries
        ) as unknown as MarkdownExportItem[])
      : [...outputs].sort(
          (left, right) =>
            left.timestamp - right.timestamp ||
            (left.sequence ?? 0) - (right.sequence ?? 0)
        );

  if (sortedOutputs.length === 0) {
    lines.push("*No output captured*");
    return lines.join("\n");
  }

  sortedOutputs.forEach((item) => {
    if (item.type === "status") {
      const statusMsg = item.data as { message: string; timestamp: string };
      lines.push(`> **[${statusMsg.timestamp}]** ${statusMsg.message}`);
      lines.push("");
    } else if (item.type === "cli") {
      const output = item.data as {
        prompt?: string;
        response?: string;
        cliCommand?: string;
        workingDirectory?: string;
        tokens?: {
          prompt: number;
          completion: number;
          cached?: number;
          contextWindowUsed?: number;
          contextWindowSize?: number;
        };
        elapsed?: number;
        structured?: {
          events: Array<{ type: string; data: unknown }>;
          metadata?: { sessionId?: string; harness?: string };
        };
      };

      const attemptLabel =
        item.attemptIndex === 0
          ? "Initial Attempt"
          : `Retry ${item.attemptIndex}`;

      const isFinalStep = item.target.kind === FINAL_STEP_PHASES.FINAL_STEP;
      const stepNum = item.target.index + 1;
      const isScript = (output as { source?: string }).source === "script";

      const stepDisplayName =
        item.stepName ||
        (isScript
          ? getFirstWords(output.cliCommand, 3)
          : getFirstWords(output.prompt, 4));

      const stepLabel = isFinalStep
        ? `Final Step Loop ${stepNum}${item.stepName ? `: ${item.stepName}` : ""}`
        : `Step ${stepNum}${stepDisplayName ? `: ${stepDisplayName}` : ""}`;

      lines.push(`## ${stepLabel} — ${attemptLabel}`);
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

      if (output.structured?.events && output.structured.events.length > 0) {
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

      const stats: string[] = [];
      const sessionId = output.structured?.metadata?.sessionId;
      const harnessId = output.structured?.metadata?.harness;
      const harnessName = harnessId
        ? (HARNESS_INFO[harnessId as keyof typeof HARNESS_INFO]?.name ??
          harnessId)
        : undefined;

      if (output.tokens) {
        const {
          prompt,
          completion,
          cached,
          contextWindowUsed,
          contextWindowSize,
        } = output.tokens;
        if (contextWindowUsed !== undefined && contextWindowSize) {
          const fmt = (n: number) =>
            n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
          const pct = Math.round((contextWindowUsed / contextWindowSize) * 100);
          stats.push(
            `Context: ${fmt(contextWindowUsed)}/${fmt(contextWindowSize)} (${pct}%)`
          );
        }
        const total = prompt + completion;
        const cachedSuffix = cached ? ` / ${cached} cached` : "";
        stats.push(
          `Tokens: ${prompt} in / ${completion} out / ${total} total${cachedSuffix}`
        );
      }
      if (sessionId) {
        stats.push(
          `Session${harnessName ? ` (${harnessName})` : ""}: ${sessionId}`
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
