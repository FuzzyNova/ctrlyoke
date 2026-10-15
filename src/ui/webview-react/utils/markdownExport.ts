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
  AskUserQuestionData,
  UserSteerData,
  CliOutput as CliOutputType,
} from "../types/cliEvents";
import { CLI_EVENT_TYPES, OPERATION_STATUS } from "../types/cliEvents";
import {
  HARNESS_INFO,
  FINAL_STEP_PHASES,
  type FinalStepPhase,
} from "../types/messages";
import {
  DIFF_LINE_TYPES,
  OUTPUT_MESSAGE_TYPES,
} from "@root/types/DashboardConstants";
import {
  formatThinkingLabel,
  isRenderableThinkingBlock,
} from "@root/utils/ThinkingBlockFormat";
import { getTargetKey } from "./outputProjection";
import { truncate } from "./string";
import {
  generateDiffLines,
  getStructuredPatchDiffLines,
  normalizeStructuredPatch,
} from "./diffUtils";
import { redactPreviewText } from "@root/types/PreviewRedactor";
import { formatMcpToolLabel } from "@root/utils/formatMcpToolLabel";
import { useSettingsStore } from "@store/settingsStore";
import {
  extractKeyParameters,
  formatExecutionBadge,
  getFirstWords,
} from "./outputUtils";
import { formatCliCommandDisplay } from "../../../utils/outputCommandDisplay";
import { isScriptOutput } from "./outputRenderUtils";
import { formatTokenCount } from "@root/utils/TokenFormatting";
import { fenceLiteral } from "@root/utils/FileReferenceParser";
import { formatFinalPassLabel } from "@root/utils/FinalStepLabels";
import { formatCreatedFileDiff } from "@root/utils/CliEventDiff";
import {
  getScriptOutputText,
  getStepOutputText,
} from "@root/utils/StepOutputText";
import { StepOutputTextMode } from "@root/types/DashboardConstants";
import type { OutputMessageTarget } from "./outputProjection";

// ── Private helpers ────────────────────────────────────────────────────────────

/**
 * Redact an assembled export document.
 *
 * Deliberately calls the pure `redactPreviewText` boundary rather than the
 * process-wide redaction singleton in `@root/utils`: that module reaches
 * ConfigurationUtils -> ExternalRootsTrustStore -> `os.homedir()`, which Vite
 * resolves to a browser stub, so importing it throws at module-eval time and
 * takes the whole dashboard down. Nothing is lost — in a browser process the
 * singleton has no registered runs and no protected values, so it only ever
 * applied the same heuristic rules this does.
 */
function redactExportText(text: string): string {
  const applyHeuristics =
    useSettingsStore.getState().fullGlobalSettings?.settings.permissions
      .heuristicSecretRedactionEnabled ?? true;
  return redactPreviewText(text, [], [], [], applyHeuristics).text;
}

interface MarkdownExportItem {
  type: (typeof OUTPUT_MESSAGE_TYPES)[keyof typeof OUTPUT_MESSAGE_TYPES];
  target: {
    kind: FinalStepPhase;
    index: number;
  };
  timestamp: number;
  sequence?: number;
  data: unknown;
  /** The attempt's prompt (see `OutputMessage.prompt`). */
  prompt?: string;
  attemptIndex?: number;
  runIndex?: number;
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
  return getStructuredPatchDiffLines(normalizeStructuredPatch(hunks)).map(
    (line) => {
      if (line.type === DIFF_LINE_TYPES.ADDED) {
        return `+${String(line.newLineNum).padStart(4)} | ${line.content}`;
      }
      if (line.type === DIFF_LINE_TYPES.REMOVED) {
        return `-${String(line.oldLineNum).padStart(4)} | ${line.content}`;
      }
      return ` ${String(line.oldLineNum).padStart(4)} | ${line.content}`;
    }
  );
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
      line.type === DIFF_LINE_TYPES.ADDED
        ? String(line.newLineNum ?? "").padStart(4)
        : String(line.oldLineNum ?? "").padStart(4);
    const prefix =
      line.type === DIFF_LINE_TYPES.ADDED
        ? "+"
        : line.type === DIFF_LINE_TYPES.REMOVED
          ? "-"
          : " ";
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

      case CLI_EVENT_TYPES.TERMINAL_OUTPUT: {
        const data = event.data as { text: string; reason: string };
        lines.push(`● Terminal output (${data.reason})`);
        lines.push("");
        lines.push(fenceLiteral(data.text.trim()));
        lines.push("");
        break;
      }

      case CLI_EVENT_TYPES.BASH_COMMAND: {
        const data = event.data as BashCommandData;
        lines.push(`● ${data.command}`);

        if (data.status !== OPERATION_STATUS.INITIATED) {
          if (data.output) {
            lines.push("");
            lines.push("  ⎿  Output:");
            lines.push(fenceLiteral(data.output.trim()));
          }

          if (data.error) {
            lines.push("");
            lines.push("  ⎿  Error:");
            lines.push(fenceLiteral(data.error.trim()));
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
            const dl = formatDiffForMarkdown(
              data.oldContent || "",
              data.newContent || "",
              data.structuredPatch
            );
            lines.push(fenceLiteral(dl.join("\n"), "diff"));
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
          if (data.content !== undefined) {
            lines.push("");
            lines.push(fenceLiteral(formatCreatedFileDiff(data), "diff"));
          }
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
        lines.push(
          formatToolCallForMarkdown(
            formatMcpToolLabel(data.server, data.tool),
            data.parameters
          )
        );
        if (data.result) lines.push(formatToolResultForMarkdown(data.result));
        lines.push("");
        break;
      }

      case CLI_EVENT_TYPES.WEB_SEARCH: {
        const data = event.data as WebSearchData;
        lines.push(`● Web search: "${data.query}"`);
        for (const result of data.results ?? []) {
          lines.push(`- [${result.title}](${result.url})`);
          if (result.snippet) lines.push(`  ${result.snippet}`);
        }
        if (data.error) lines.push(`  Error: ${data.error}`);
        lines.push("");
        break;
      }

      case CLI_EVENT_TYPES.ASK_USER_QUESTION: {
        const data = event.data as AskUserQuestionData;
        for (const question of data.questions) {
          lines.push(`● Question: ${question.question}`);
          if (question.answer) lines.push(`  Answer: ${question.answer}`);
          if (question.notes) lines.push(`  Notes: ${question.notes}`);
        }
        if (data.declined?.feedback) {
          lines.push(`  Feedback: ${data.declined.feedback}`);
        }
        lines.push("");
        break;
      }

      case CLI_EVENT_TYPES.USER_STEER: {
        const data = event.data as UserSteerData;
        lines.push(`● User steer: ${data.text}`);
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
        if (isRenderableThinkingBlock(data)) {
          const label = formatThinkingLabel(data);
          lines.push(data.text ? `● ${label}: ${data.text}` : `● ${label}`);
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

      // Timeline markers with no standalone user-facing export representation.
      case CLI_EVENT_TYPES.COMPACTION:
      case CLI_EVENT_TYPES.FOLLOW_UP_RESUMED:
      case CLI_EVENT_TYPES.BACKGROUND_WORK_HOLD:
      case CLI_EVENT_TYPES.CONTEXT_WINDOW_SYNC:
        break;

      default: {
        const exhaustive = event.type satisfies never;
        throw new Error(`Unhandled CLI event type: ${exhaustive}`);
      }
    }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface ExportOptions {
  /** Include the CLI command section for prompt steps. Default: true. */
  includeCommand?: boolean;
  /**
   * Include metadata: document header, step headings, token stats, session IDs,
   * and horizontal rule separators. Default: true.
   * When false, only prompt text, command (if enabled), and response output are emitted.
   */
  includeMetadata?: boolean;
  /** Include the prompt heading even when metadata sections are omitted. */
  includePromptHeading?: boolean;
  /**
   * 1-based step numbers to include. When undefined all steps are exported.
   * e.g. [1,2,3,5] exports steps 1–3 and 5.
   */
  stepRange?: number[];
}

/** Order live output messages by timestamp, then by sequence. */
export function sortByOutputOrder<
  T extends { timestamp: number; sequence?: number },
>(items: ReadonlyArray<T>): T[] {
  return [...items].sort(
    (left, right) =>
      left.timestamp - right.timestamp ||
      (left.sequence ?? 0) - (right.sequence ?? 0)
  );
}

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
    /** `outputs` are already in display order; skip the timestamp sort. */
    preordered?: boolean;
    exportOptions?: ExportOptions;
  }
): string {
  const lines: string[] = [];
  const includeCommand = options?.exportOptions?.includeCommand ?? true;
  const includeMetadata = options?.exportOptions?.includeMetadata ?? true;
  const includePromptHeading =
    options?.exportOptions?.includePromptHeading ?? includeMetadata;
  const stepRange = options?.exportOptions?.stepRange;

  if (includeMetadata) {
    const timestamp = new Date().toISOString();
    lines.push("# ctrlyoke Execution Output");
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
  }

  const sortedOutputs: readonly MarkdownExportItem[] = options?.preordered
    ? outputs
    : sortByOutputOrder(outputs);

  // Assign sequential 1-based step numbers to unique CLI steps in appearance order.
  const stepSequence = new Map<string, number>();
  let seq = 0;
  for (const item of sortedOutputs) {
    if (item.type === OUTPUT_MESSAGE_TYPES.CLI) {
      const key = getTargetKey(item.target);
      if (!stepSequence.has(key)) {
        seq++;
        stepSequence.set(key, seq);
      }
    }
  }

  // Apply step range filter: exclude status messages when a range is active.
  const filteredOutputs = stepRange
    ? sortedOutputs.filter((item) => {
        if (item.type === OUTPUT_MESSAGE_TYPES.STATUS) return false;
        const key = getTargetKey(item.target);
        const num = stepSequence.get(key);
        return num !== undefined && stepRange.includes(num);
      })
    : sortedOutputs;

  if (filteredOutputs.length === 0) {
    lines.push("*No output captured*");
    return redactExportText(lines.join("\n"));
  }

  filteredOutputs.forEach((item) => {
    if (item.type === OUTPUT_MESSAGE_TYPES.STATUS) {
      if (!includeMetadata) return;
      const statusMsg = item.data as { message: string; timestamp: string };
      lines.push(`> **[${statusMsg.timestamp}]** ${statusMsg.message}`);
      lines.push("");
    } else if (item.type === OUTPUT_MESSAGE_TYPES.CLI) {
      const output = item.data as {
        cliCommand?: string;
        cliCommandWasInjected?: boolean;
        workingDirectory?: string;
        source?: CliOutputType["source"];
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
        scriptOutput?: CliOutputType["scriptOutput"];
      };

      if (includeMetadata) {
        const executionLabel = formatExecutionBadge(
          item.runIndex ?? 0,
          item.attemptIndex ?? 0,
          true
        );
        const isFinalStep = item.target.kind === FINAL_STEP_PHASES.FINAL_STEP;
        const stepNum = item.target.index + 1;
        const isScript = isScriptOutput(output);
        const stepDisplayName =
          item.stepName ||
          (isScript
            ? getFirstWords(output.cliCommand, 3)
            : getFirstWords(item.prompt, 4));
        const stepLabel = isFinalStep
          ? `${formatFinalPassLabel(stepNum)}${item.stepName ? `: ${item.stepName}` : ""}`
          : `Step ${stepNum}${stepDisplayName ? `: ${stepDisplayName}` : ""}`;
        lines.push(`## ${stepLabel} — ${executionLabel}`);
        lines.push("");
      }

      if (item.prompt && !isScriptOutput(output)) {
        if (includePromptHeading) lines.push("### Prompt");
        lines.push("");
        lines.push(fenceLiteral(item.prompt));
        lines.push("");
      }

      if ((includeCommand || isScriptOutput(output)) && output.cliCommand) {
        if (includeMetadata) lines.push("### CLI Command");
        lines.push("");
        lines.push(
          fenceLiteral(
            formatCliCommandDisplay(
              output.cliCommand,
              output.workingDirectory,
              output.cliCommandWasInjected
            ),
            output.cliCommandWasInjected ? "" : "bash"
          )
        );
        lines.push("");
      }

      if (output.structured?.events && output.structured.events.length > 0) {
        if (includeMetadata) lines.push("### Response");
        lines.push("");
        renderStructuredEventsToMarkdown(
          output.structured.events as CliEvent[],
          lines
        );
      } else if (output.scriptOutput) {
        if (includeMetadata) lines.push("### Response");
        lines.push("");
        lines.push(fenceLiteral(getScriptOutputText(output.scriptOutput)));
        lines.push("");
      } else if (
        getStepOutputText(
          {
            output: output as CliOutputType,
            scriptOutput: output.scriptOutput,
          },
          StepOutputTextMode.TRANSCRIPT
        )
      ) {
        if (includeMetadata) lines.push("### Response");
        lines.push("");
        lines.push(
          fenceLiteral(
            getStepOutputText(
              {
                output: output as CliOutputType,
                scriptOutput: output.scriptOutput,
              },
              StepOutputTextMode.TRANSCRIPT
            )
          )
        );
        lines.push("");
      }

      if (includeMetadata) {
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
            const pct = Math.round(
              (contextWindowUsed / contextWindowSize) * 100
            );
            stats.push(
              `Context: ${formatTokenCount(contextWindowUsed)}/${formatTokenCount(contextWindowSize)} (${pct}%)`
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
    }
  });

  return redactExportText(lines.join("\n"));
}

/** Generate the complete, metadata-free export for one step/pass. */
export function generateSingleStepMarkdownExport(
  output: CliOutputType,
  target: OutputMessageTarget,
  prompt?: string
): string {
  return generateMarkdownExport(
    [
      {
        type: OUTPUT_MESSAGE_TYPES.CLI,
        target,
        timestamp: output.timestampMs ?? 0,
        data: output,
        prompt,
      },
    ],
    { fileName: "", executionState: "", currentStep: 0, totalSteps: 0 },
    {
      exportOptions: {
        stepRange: [1],
        includeMetadata: false,
        includePromptHeading: true,
      },
    }
  );
}
