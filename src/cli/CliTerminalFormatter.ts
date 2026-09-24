import chalk from "chalk";
import * as Diff from "diff";
import { COMMAND_DISPLAY_SHELL_LABELS } from "../types/CommandDisplayFormatter";
import type { CliEvent } from "../types/CliOutputTypes";
import type {
  TextData,
  ThinkingBlock,
  BashCommandData,
  FileReadData,
  FileWriteData,
  FileEditData,
  FileDeleteData,
  McpToolCallData,
  WebSearchData,
  ToolCall,
  ToolResultData,
  UnifiedDiffHunk,
  AskUserQuestionData,
  AskUserQuestionDeclined,
  CompactionData,
  FollowUpResumedData,
  BackgroundWorkHoldData,
} from "../types/CliOutputTypes";
import {
  getBackgroundTaskLabel,
  getBackgroundWorkHoldHeadline,
} from "../utils/BackgroundWorkHoldText";
import {
  CLI_EVENT_TYPES,
  OPERATION_STATUS,
  PREVIEW_PROMPT_CATEGORY_LABELS,
  PREVIEW_MUTATION_SCOPES,
  PREVIEW_TRUNCATION_REASON_COPY,
  PREVIEW_TRUNCATION_REASONS,
  SCRIPT_OUTPUT_SOURCES,
  SCRIPT_SOURCE_LABELS,
  SCRIPT_VERDICT_OUTCOMES,
  STATUS_MESSAGE_SEVERITY,
  type HarnessId,
} from "../types/DashboardConstants";
import type { ScriptVerdict } from "../types/CtrlYokeTypes";
import type { CliOutput } from "../types/WebviewMessageTypes";
import { formatVerdictSummary } from "../core/orchestration/ScriptExecutionReporter";
import { formatComparison } from "../utils/ScriptComparison";
import type {
  PromptCompleteData,
  PromptStartData,
} from "../core/WorkflowInstance";
import type { ParallelGroupDefinition } from "../types/CtrlYokeTypes";
import type { WorkflowExecutionPreview } from "../types/ExecutionPreviewTypes";
import {
  formatTokenBreakdown,
  formatCostLabel,
  formatCostSourcePhrase,
  formatTokenCount,
  resolveTokenTotal,
  TOKEN_USAGE_SCOPE_NOTE,
  TOKEN_TOTAL_CACHE_NETTED_NOTE,
  isCacheInputSubset,
} from "../utils/TokenFormatting";
import { secretRedactionService } from "../utils/SecretRedactionService";

/** Maximum diff lines shown before truncating with a "… N more" message. */
const MAX_DIFF_LINES = 60;
/** Maximum prompt lines shown in the terminal's bounded preview. */
const MAX_PREVIEW_LINES = 20;
const MAX_EVENT_DETAIL_LINES = 8;
const MAX_EVENT_DETAIL_LINE_LENGTH = 200;
const MAX_SCRIPT_OUTPUT_LINES = 200;
const MAX_SCRIPT_OUTPUT_CHARS = 20_000;
const MAX_SCRIPT_VERDICT_FIELD_LINES = 20;
const MAX_SCRIPT_VERDICT_FIELD_CHARS = 4_000;
const EVENTS_LOG_PATH_HINT = ".ctrlyoke/.runs/…/events.jsonl";
const SCRIPT_OUTPUT_BORDER = "#c878ff";
const ASK_USER_QUESTION_DECLINE_LABELS = {
  clarify: "Asked to clarify",
  rejected: "Question declined",
} as const satisfies Record<AskUserQuestionDeclined["reason"], string>;

interface ScriptStreamingState {
  shownChars: number;
  shownLines: number;
  totalChars: number;
  totalLines: number;
  endsWithNewline: boolean;
}

function countOutputLines(text: string): number {
  if (!text) return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

function formatTruncationNotice(detail: string): string {
  return `… ${detail} (see ${EVENTS_LOG_PATH_HINT})`;
}

function truncateEventText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)} ${formatTruncationNotice(
    `${text.length - maxChars} more characters`
  )}`;
}

function scriptOutputLabel(output: CliOutput): string | undefined {
  return output.source === undefined
    ? undefined
    : SCRIPT_SOURCE_LABELS[output.source];
}

function scriptHeaderLabel(output: CliOutput): string | undefined {
  const label = scriptOutputLabel(output);
  if (!label) return undefined;
  return output.source === SCRIPT_OUTPUT_SOURCES.END_CONDITION &&
    (output.attemptIndex ?? 0) > 0
    ? `${label} retry ${(output.attemptIndex ?? 0) + 1}`
    : label;
}

function scriptCompareLabel(verdict: ScriptVerdict): string {
  return formatComparison(verdict);
}

function scriptOutcomePresentation(outcome: ScriptVerdict["outcome"]): {
  icon: string;
  label: string;
  color: (text: string) => string;
} {
  if (outcome === SCRIPT_VERDICT_OUTCOMES.PASSED) {
    return { icon: "✔", label: "Passed", color: chalk.green };
  }
  if (outcome === SCRIPT_VERDICT_OUTCOMES.FAILED) {
    return { icon: "✖", label: "Failed", color: chalk.red };
  }
  return { icon: "⚠", label: "Errored", color: chalk.yellow };
}

export interface CliOutputTarget {
  stepIndex: number;
  stepName: string;
  key?: string;
}

/** Prompt-header details resolved by the CLI from the active workflow runtime. */
export interface CliPromptHeaderData extends PromptStartData {
  harness?: HarnessId;
  model?: string;
}

const DIFF_LINE_TYPES = {
  ADDED: "added",
  REMOVED: "removed",
  CONTEXT: "context",
} as const;
type DiffLineType = (typeof DIFF_LINE_TYPES)[keyof typeof DIFF_LINE_TYPES];

// ---- Diff helpers (ported from webview outputUtils — no shared import to avoid bundle coupling) ----

interface DiffLine {
  type: DiffLineType;
  oldLineNum?: number;
  newLineNum?: number;
  content: string;
}

function parseUnifiedDiff(hunks: UnifiedDiffHunk[]): DiffLine[] {
  const lines: DiffLine[] = [];
  for (const hunk of hunks) {
    let oldLineNum = hunk.oldStart;
    let newLineNum = hunk.newStart;
    for (const line of hunk.lines) {
      const prefix = line[0];
      const content = line.slice(1);
      if (prefix === "+") {
        lines.push({ type: DIFF_LINE_TYPES.ADDED, newLineNum, content });
        newLineNum++;
      } else if (prefix === "-") {
        lines.push({ type: DIFF_LINE_TYPES.REMOVED, oldLineNum, content });
        oldLineNum++;
      } else {
        lines.push({
          type: DIFF_LINE_TYPES.CONTEXT,
          oldLineNum,
          newLineNum,
          content,
        });
        oldLineNum++;
        newLineNum++;
      }
    }
  }
  return lines;
}

function generateDiffLines(oldContent: string, newContent: string): DiffLine[] {
  const diffResult = Diff.diffLines(oldContent, newContent);
  const lines: DiffLine[] = [];
  let oldLineNum = 1;
  let newLineNum = 1;
  for (const part of diffResult) {
    const partLines = part.value.split("\n");
    if (partLines[partLines.length - 1] === "") partLines.pop();
    for (const line of partLines) {
      if (part.added) {
        lines.push({
          type: DIFF_LINE_TYPES.ADDED,
          newLineNum,
          content: line,
        });
        newLineNum++;
      } else if (part.removed) {
        lines.push({
          type: DIFF_LINE_TYPES.REMOVED,
          oldLineNum,
          content: line,
        });
        oldLineNum++;
      } else {
        lines.push({
          type: DIFF_LINE_TYPES.CONTEXT,
          oldLineNum,
          newLineNum,
          content: line,
        });
        oldLineNum++;
        newLineNum++;
      }
    }
  }
  return lines;
}

// ---- Diff renderer ----

function renderDiffBlock(data: FileEditData): void {
  let lines: DiffLine[];
  if (data.structuredPatch && data.structuredPatch.length > 0) {
    lines = parseUnifiedDiff(data.structuredPatch);
  } else if (data.oldContent !== undefined && data.newContent !== undefined) {
    lines = generateDiffLines(data.oldContent, data.newContent);
  } else {
    return;
  }

  if (lines.length === 0) return;

  const displayLines = lines.slice(0, MAX_DIFF_LINES);
  const remaining = lines.length - displayLines.length;

  const maxNum = Math.max(
    ...lines.map((l) => Math.max(l.oldLineNum ?? 0, l.newLineNum ?? 0))
  );
  const numWidth = Math.max(3, String(maxNum).length);

  for (const line of displayLines) {
    const oldN =
      line.oldLineNum !== undefined
        ? String(line.oldLineNum).padStart(numWidth)
        : " ".repeat(numWidth);
    const newN =
      line.newLineNum !== undefined
        ? String(line.newLineNum).padStart(numWidth)
        : " ".repeat(numWidth);
    const nums = chalk.dim(`${oldN} ${newN}`);

    switch (line.type) {
      case DIFF_LINE_TYPES.ADDED:
        console.log(chalk.green(`  ${nums} + ${line.content}`));
        break;
      case DIFF_LINE_TYPES.REMOVED:
        console.log(chalk.red(`  ${nums} - ${line.content}`));
        break;
      case DIFF_LINE_TYPES.CONTEXT:
        console.log(chalk.dim(`  ${nums}   ${line.content}`));
        break;
    }
  }

  if (remaining > 0) {
    console.log(
      chalk.dim(
        `  ${formatTruncationNotice(`${remaining} more line${remaining !== 1 ? "s" : ""}`)}`
      )
    );
  }
}

function writeEventLine(
  content: string,
  border: (text: string) => string = chalk.cyan
): void {
  console.log(`${border("│")} ${content}`);
}

/** Write bounded secondary event detail with an explicit truncation notice. */
function writeBoundedEventDetail(
  text: string,
  maxLines: number,
  indentation: string,
  border: (text: string) => string = chalk.cyan
): void {
  const lines = text.split(/\r?\n/);
  const displayedLines = lines.slice(0, maxLines);

  for (const line of displayedLines) {
    if (line.length > MAX_EVENT_DETAIL_LINE_LENGTH) {
      writeEventLine(
        chalk.dim(
          `${indentation}${line.slice(0, MAX_EVENT_DETAIL_LINE_LENGTH)}…`
        ),
        border
      );
      writeEventLine(
        chalk.dim(
          `${indentation}${formatTruncationNotice(`${line.length - MAX_EVENT_DETAIL_LINE_LENGTH} more characters`)}`
        ),
        border
      );
    } else {
      writeEventLine(chalk.dim(`${indentation}${line}`), border);
    }
  }

  const remaining = lines.length - displayedLines.length;
  if (remaining > 0) {
    writeEventLine(
      chalk.dim(
        `${indentation}${formatTruncationNotice(`${remaining} more line${remaining !== 1 ? "s" : ""}`)}`
      ),
      border
    );
  }
}

function formatAskUserQuestionCount(count: number): string {
  return `${count} question${count === 1 ? "" : "s"}`;
}

function formatAskUserQuestionDecline(
  declined: AskUserQuestionDeclined
): string {
  return ASK_USER_QUESTION_DECLINE_LABELS[declined.reason];
}

// ---- Main formatter ----

/**
 * Chalk-based terminal renderer for CliEvent arrays.
 * Used by the standalone ctrlyoke CLI to stream structured output to stdout.
 */
export class CliTerminalFormatter {
  /**
   * Applies a command's `--no-color` decision to every chalk call in the
   * bundle.
   *
   * This must mutate `chalk.level` rather than write `process.env.NO_COLOR`:
   * chalk 5 resolves its level once while the module initializes, which in the
   * esbuild bundle happens before any command action runs, so an env write at
   * action time is silently ignored. A `NO_COLOR` the user exported before
   * launching ctrlyoke is unaffected — that one is read in time.
   *
   * Passing `true` is deliberately a no-op rather than a force-on: it must not
   * override chalk's own TTY/pipe detection, which is what keeps redirected
   * output clean without the flag.
   */
  static setColorEnabled(enabled: boolean): void {
    if (!enabled) {
      chalk.level = 0;
    }
  }

  /** Renders the live start marker for one workflow parallel group. */
  static renderParallelGroupHeader(
    group: ParallelGroupDefinition,
    memberCount: number
  ): void {
    console.log();
    console.log(
      chalk.bold(`Parallel group ${group.id} — ${memberCount} member(s)`)
    );
  }

  /** Renders the current live branch tally for one workflow parallel group. */
  static renderParallelGroupProgress(
    groupId: string,
    running: number,
    completed: number,
    failed: number
  ): void {
    console.log(
      chalk.dim(
        `  Parallel group ${groupId}: ${running} running · ${completed} done · ${failed} failed`
      )
    );
  }

  /** Renders the collapsed aggregate for a step's retry attempts. */
  static renderAttemptGroupSummary(
    stepName: string,
    attemptCount: number,
    totalElapsed: number
  ): void {
    console.log();
    console.log(
      chalk.dim(
        `↻ ${stepName}: ${attemptCount} attempts · ${totalElapsed}s total`
      )
    );
  }

  /** Renders the caption that starts one finalStep loop in the terminal stream. */
  static renderFinalStepLabel(loopIndex: number): void {
    console.log();
    console.log(
      `${chalk.blue("│")} ${chalk.dim(`Final Step Loop ${loopIndex + 1}`)}`
    );
  }

  /** Render a complete, redacted dry-run snapshot with diagnostics first. */
  static renderExecutionPreview(
    preview: WorkflowExecutionPreview,
    writeLine: (line: string) => void = (line) => console.log(line)
  ): void {
    preview = secretRedactionService.redactValue(preview);
    writeLine(chalk.bold(`Dry run: ${preview.workflow.name}`));
    writeLine(
      chalk.dim(
        `${preview.workflow.stepCount} step(s) · ${preview.workflow.totalByteCount} payload bytes · ${preview.workflow.workspaceMutationCount} planned workspace mutation(s)`
      )
    );
    writeLine("");

    if (preview.diagnostics.length > 0) {
      writeLine(chalk.bold("Diagnostics"));
      for (const diagnostic of preview.diagnostics) {
        writeLine(
          `${formatDiagnosticSeverity(diagnostic.severity)} ${diagnostic.code}: ${diagnostic.message}`
        );
      }
      writeLine("");
    }

    writeLine(chalk.bold("Steps"));
    const renderedGroups = new Set<string>();
    for (const step of preview.steps) {
      const group = step.parallelGroupId
        ? preview.parallelGroups.find(
            (candidate) => candidate.id === step.parallelGroupId
          )
        : undefined;
      if (group && !renderedGroups.has(group.id)) {
        renderedGroups.add(group.id);
        const groupPreflight = preview.parallelGroupPreflights.find(
          (candidate) => candidate.parallelGroupId === group.id
        );
        const effectiveWidth = groupPreflight?.effectiveWidth ?? 1;
        const executableMemberCount =
          groupPreflight?.executableMemberCount ??
          group.endIndex - group.startIndex + 1;
        writeLine(
          chalk.bold(
            `Parallel steps ${group.startIndex + 1}–${group.endIndex + 1}${group.failFast ? " (failFast)" : ""}`
          )
        );
        writeLine(
          chalk.dim(
            effectiveWidth <= 1
              ? "  runs sequentially"
              : `  ${Math.min(executableMemberCount, effectiveWidth)} of ${executableMemberCount} will run concurrently (width ${effectiveWidth})`
          )
        );
      }
      const indent = group ? "  " : "";
      const name = step.stepName ? ` — ${step.stepName}` : "";
      writeLine(`${indent}Step ${step.stepIndex + 1}${name} (${step.type})`);
      writeLine(`${indent}  Harness: ${step.resolvedProperties.harnessId}`);
      if (step.resolvedProperties.model) {
        writeLine(`${indent}  Model: ${step.resolvedProperties.model}`);
      }
      if (step.command) {
        writeLine(
          `${indent}  Command (${COMMAND_DISPLAY_SHELL_LABELS[step.command.displayShell]}): ${step.command.displayCommand}`
        );
      }
      for (const variable of step.variables) {
        writeLine(`${indent}  Variable: ${variable.name}=${variable.value}`);
      }
      for (const section of step.prompt?.sections ?? []) {
        const includedBytes = section.body
          ? Buffer.byteLength(section.body, "utf8")
          : 0;
        const lineInfo = section.lineCount === null ? "?" : section.lineCount;
        writeLine(
          `${indent}  Payload: ${PREVIEW_PROMPT_CATEGORY_LABELS[section.category]} — ${section.byteCount} bytes, ${lineInfo} lines, chunk ${section.chunkIndex}`
        );
        if (section.body) {
          for (const line of section.body.split("\n")) {
            writeLine(`${indent}    ${line}`);
          }
        }
        if (section.truncationReason) {
          const delivery =
            section.truncationReason === PREVIEW_TRUNCATION_REASONS.REFERENCE
              ? PREVIEW_TRUNCATION_REASON_COPY[
                  PREVIEW_TRUNCATION_REASONS.REFERENCE
                ]
              : section.truncationReason ===
                  PREVIEW_TRUNCATION_REASONS.NOT_YET_AVAILABLE
                ? PREVIEW_TRUNCATION_REASON_COPY[
                    PREVIEW_TRUNCATION_REASONS.NOT_YET_AVAILABLE
                  ]
                : "the full planned payload remains available to the harness";
          const line = `${indent}    [truncated: showing ${includedBytes} of ${section.byteCount} bytes; reason=${section.truncationReason}; ${delivery}]`;
          writeLine(
            section.truncationReason ===
              PREVIEW_TRUNCATION_REASONS.NOT_YET_AVAILABLE
              ? line
              : chalk.yellow(line)
          );
        }
      }
      for (const mutation of step.workspaceMutations) {
        const mutationPath = mutation.path ? ` ${mutation.path}` : "";
        const warning =
          mutation.scope === PREVIEW_MUTATION_SCOPES.SHARED && mutation.warning
            ? ` — ${mutation.warning}`
            : "";
        writeLine(
          `${indent}  Mutation: ${mutation.operation}${mutationPath}${warning}`
        );
      }
      writeLine("");
    }
  }

  /**
   * Live streaming state — tracks which block type is currently streaming so we
   * print the THINKING header once and write each chunk directly to stdout as it
   * arrives (typewriter effect), rather than buffering and dumping all at once.
   */
  private static _streaming = new Map<
    string,
    {
      type: typeof CLI_EVENT_TYPES.TEXT | typeof CLI_EVENT_TYPES.THINKING;
      label?: string;
      /** Whether the last character written ended with a newline (for TEXT blocks). */
      endsWithNewline: boolean;
    }
  >();

  private static _scriptStreaming = new Map<string, ScriptStreamingState>();
  private static _scriptHeaders = new Set<string>();

  private static targetKey(target?: CliOutputTarget): string {
    return target?.key ?? (target ? `queue:${target.stepIndex}` : "default");
  }

  private static writeTargetPrefix(target?: CliOutputTarget): void {
    if (!target) return;
    process.stdout.write(
      chalk.dim(`[${target.stepIndex + 1} ${target.stepName}] `)
    );
  }

  /**
   * Returns the exact one-line status summary emitted by the script reporter.
   * The CLI uses it to collapse that status into the richer verdict block.
   */
  static getScriptVerdictStatusSummary(output: CliOutput): string | undefined {
    const verdict = output.scriptVerdict;
    const label = scriptOutputLabel(output);
    return verdict && label ? formatVerdictSummary(label, verdict) : undefined;
  }

  /** Renders the command, bounded streamed output, and completed script verdict. */
  static renderScriptOutput(output: CliOutput, target: CliOutputTarget): void {
    const sourceLabel = scriptOutputLabel(output);
    if (!sourceLabel) return;

    const key = CliTerminalFormatter.targetKey(target);
    const border = chalk.hex(SCRIPT_OUTPUT_BORDER)("│");
    const headerKey = `${key}:${output.runIndex ?? 0}:${output.attemptIndex ?? 0}:${output.source}`;
    if (!CliTerminalFormatter._scriptHeaders.has(headerKey)) {
      CliTerminalFormatter.flushStreamingBuffer(target);
      console.log(
        `${border} ${chalk.bold(`[${scriptHeaderLabel(output) ?? sourceLabel}]`)}${target.stepName ? ` ${target.stepName}` : ""}`
      );
      CliTerminalFormatter._scriptHeaders.add(headerKey);
    }
    let state = CliTerminalFormatter._scriptStreaming.get(key);

    if (output.isStreaming) {
      CliTerminalFormatter.flushStreamingBuffer(target);
      if (output.cliCommand !== undefined) {
        console.log(`${border} ${chalk.dim("$ " + output.cliCommand)}`);
        console.log();
      }
      if (output.response) {
        if (!state) {
          state = {
            shownChars: 0,
            shownLines: 0,
            totalChars: 0,
            totalLines: 0,
            endsWithNewline: true,
          };
          CliTerminalFormatter._scriptStreaming.set(key, state);
          console.log(`${border} ${chalk.dim(`${sourceLabel} output:`)}`);
        }
        CliTerminalFormatter.writeBoundedScriptChunk(output.response, state);
      }
      return;
    }

    if (!state && output.response) {
      state = {
        shownChars: 0,
        shownLines: 0,
        totalChars: 0,
        totalLines: 0,
        endsWithNewline: true,
      };
      CliTerminalFormatter._scriptStreaming.set(key, state);
      CliTerminalFormatter.flushStreamingBuffer(target);
      console.log(`${border} ${chalk.dim(`${sourceLabel} output:`)}`);
      CliTerminalFormatter.writeBoundedScriptChunk(output.response, state);
    }

    if (state) {
      const totalText = output.response;
      state.totalChars = Math.max(state.totalChars, totalText.length);
      state.totalLines = Math.max(
        state.totalLines,
        countOutputLines(totalText)
      );
      if (!state.endsWithNewline) process.stdout.write("\n");
      const omittedLines = Math.max(0, state.totalLines - state.shownLines);
      const omittedChars = Math.max(0, state.totalChars - state.shownChars);
      if (omittedLines > 0 || omittedChars > 0) {
        const omitted = [
          omittedLines > 0 ? `${omittedLines} more lines` : "",
          omittedChars > 0 ? `${omittedChars} more characters` : "",
        ]
          .filter(Boolean)
          .join(", ");
        console.log(
          `${border} ${chalk.yellow(formatTruncationNotice(`script output truncated: ${omitted}`))}`
        );
      }
    }

    if (output.scriptVerdict) {
      CliTerminalFormatter.renderScriptVerdict(
        output.scriptVerdict,
        sourceLabel,
        border
      );
    }
    CliTerminalFormatter._scriptStreaming.delete(key);
    CliTerminalFormatter._scriptHeaders.delete(headerKey);
  }

  private static writeBoundedScriptChunk(
    chunk: string,
    state: ScriptStreamingState
  ): void {
    state.totalChars += chunk.length;
    state.totalLines += countOutputLines(chunk);

    const remainingChars = Math.max(
      0,
      MAX_SCRIPT_OUTPUT_CHARS - state.shownChars
    );
    const remainingLines = Math.max(
      0,
      MAX_SCRIPT_OUTPUT_LINES - state.shownLines
    );
    if (remainingChars === 0 || remainingLines === 0) return;

    let visible = chunk.slice(0, remainingChars);
    const visibleLines = countOutputLines(visible);
    if (visibleLines > remainingLines) {
      const pieces = visible.split("\n");
      visible = pieces.slice(0, remainingLines).join("\n");
    }
    if (!visible) return;

    process.stdout.write(visible);
    state.shownChars += visible.length;
    state.shownLines += countOutputLines(visible);
    state.endsWithNewline = visible.endsWith("\n");
  }

  private static renderScriptVerdict(
    verdict: ScriptVerdict,
    sourceLabel: string,
    border: string
  ): void {
    const presentation = scriptOutcomePresentation(verdict.outcome);
    const summary = formatVerdictSummary(sourceLabel, verdict);
    console.log(
      `${border} ${presentation.color(`${presentation.icon} ${presentation.label}`)} ${chalk.dim(`— ${summary}`)}`
    );
    console.log(`${border}   Compare: ${scriptCompareLabel(verdict)}`);
    CliTerminalFormatter.writeBoundedScriptField(
      "Expected",
      verdict.expected ?? "exit code 0 (no `returns` set)",
      border
    );
    CliTerminalFormatter.writeBoundedScriptField(
      "Actual",
      verdict.actual || "∅",
      border
    );
    console.log(
      `${border}   Result: ${presentation.label}${verdict.timedOut ? " (timed out)" : ""}`
    );
    console.log(
      `${border}   Action: ${verdict.action}${verdict.actionDetail ? ` (${verdict.actionDetail})` : ""}`
    );
    console.log(
      `${border}   Exit code: ${verdict.exitCode === undefined ? "—" : verdict.exitCode}`
    );
    console.log(
      `${border}   Duration: ${(verdict.durationMs / 1000).toFixed(1)}s`
    );
    console.log(`${border}   Timed out: ${verdict.timedOut ? "yes" : "no"}`);
    if (verdict.error) {
      CliTerminalFormatter.writeBoundedScriptField(
        "Error",
        verdict.error,
        border,
        chalk.red
      );
    }
    console.log();
  }

  private static writeBoundedScriptField(
    label: string,
    value: string,
    border: string,
    color: (text: string) => string = (text) => text
  ): void {
    const charLimited = value.slice(0, MAX_SCRIPT_VERDICT_FIELD_CHARS);
    const lines = charLimited.split("\n");
    const visibleLines = lines.slice(0, MAX_SCRIPT_VERDICT_FIELD_LINES);
    const visible = visibleLines.join("\n");
    const omittedLines = Math.max(
      0,
      value.split("\n").length - visibleLines.length
    );
    const omittedChars = Math.max(0, value.length - visible.length);
    const firstLine = visibleLines[0] ?? "";
    console.log(`${border}   ${label}: ${color(firstLine)}`);
    for (const line of visibleLines.slice(1)) {
      console.log(`${border}     ${color(line)}`);
    }
    if (omittedLines > 0 || omittedChars > 0) {
      const omitted = [
        omittedLines > 0 ? `${omittedLines} more lines` : "",
        omittedChars > 0 ? `${omittedChars} more characters` : "",
      ]
        .filter(Boolean)
        .join(", ");
      console.log(
        `${border}     ${chalk.yellow(formatTruncationNotice(omitted))}`
      );
    }
  }

  /**
   * Close the current streaming block by writing its trailing newline separator.
   * Call this when the prompt completes or when a non-TEXT/THINKING event arrives.
   */
  static flushStreamingBuffer(target?: CliOutputTarget): void {
    if (target) {
      if (
        !CliTerminalFormatter._streaming.has(
          CliTerminalFormatter.targetKey(target)
        )
      ) {
        return;
      }
      CliTerminalFormatter._streaming.delete(
        CliTerminalFormatter.targetKey(target)
      );
    } else if (CliTerminalFormatter._streaming.size === 0) {
      return;
    } else {
      CliTerminalFormatter._streaming.clear();
    }
    // End the block with a blank line separator
    process.stdout.write("\n\n");
  }

  /**
   * Renders an array of CLI events to stdout with chalk formatting.
   */
  static renderEvents(events: CliEvent[], target?: CliOutputTarget): void {
    for (const event of events) {
      CliTerminalFormatter.renderEvent(event, target);
    }
  }

  static renderStreamingChunk(chunk: string, target?: CliOutputTarget): void {
    if (!chunk) return;
    const key = CliTerminalFormatter.targetKey(target);
    const existing = CliTerminalFormatter._streaming.get(key);
    if (!existing || existing.type !== CLI_EVENT_TYPES.TEXT) {
      CliTerminalFormatter.flushStreamingBuffer(target);
      CliTerminalFormatter.writeTargetPrefix(target);
      CliTerminalFormatter._streaming.set(key, {
        type: CLI_EVENT_TYPES.TEXT,
        endsWithNewline: false,
      });
    } else if (existing.endsWithNewline) {
      CliTerminalFormatter.writeTargetPrefix(target);
    }
    process.stdout.write(chunk);
    const state = CliTerminalFormatter._streaming.get(key);
    if (state) state.endsWithNewline = chunk.endsWith("\n");
  }

  static renderEvent(event: CliEvent, target?: CliOutputTarget): void {
    event = secretRedactionService.redactValue(event);
    const key = CliTerminalFormatter.targetKey(target);
    if (
      event.type !== CLI_EVENT_TYPES.TEXT &&
      event.type !== CLI_EVENT_TYPES.THINKING
    ) {
      CliTerminalFormatter.flushStreamingBuffer(target);
      CliTerminalFormatter.writeTargetPrefix(target);
    }
    switch (event.type) {
      case CLI_EVENT_TYPES.TEXT: {
        const data = event.data as TextData;
        if (!data.text) break;
        const s = CliTerminalFormatter._streaming.get(key);
        if (!s || s.type !== CLI_EVENT_TYPES.TEXT) {
          // End any prior THINKING block, then start streaming TEXT
          CliTerminalFormatter.flushStreamingBuffer(target);
          CliTerminalFormatter.writeTargetPrefix(target);
          CliTerminalFormatter._streaming.set(key, {
            type: CLI_EVENT_TYPES.TEXT,
            endsWithNewline: false,
          });
        }
        process.stdout.write(data.text);
        const state = CliTerminalFormatter._streaming.get(key);
        if (state) state.endsWithNewline = data.text.endsWith("\n");
        break;
      }

      case CLI_EVENT_TYPES.THINKING: {
        const data = event.data as ThinkingBlock;
        if (!data.text) break;
        const label = data.label ?? "Thinking";
        const s = CliTerminalFormatter._streaming.get(key);
        if (
          !s ||
          s.type !== CLI_EVENT_TYPES.THINKING ||
          (s.label ?? "Thinking") !== label
        ) {
          // End any prior block, print header once, then start streaming this THINKING block
          CliTerminalFormatter.flushStreamingBuffer(target);
          CliTerminalFormatter.writeTargetPrefix(target);
          process.stdout.write(chalk.dim(`● ${label}\n  `));
          CliTerminalFormatter._streaming.set(key, {
            type: CLI_EVENT_TYPES.THINKING,
            label,
            endsWithNewline: false,
          });
        }
        // Indent newlines within the chunk to keep thinking text aligned under the header
        process.stdout.write(chalk.dim(data.text.replace(/\n/g, "\n  ")));
        const state = CliTerminalFormatter._streaming.get(key);
        if (state) state.endsWithNewline = data.text.endsWith("\n");
        break;
      }

      case CLI_EVENT_TYPES.BASH_COMMAND: {
        CliTerminalFormatter.flushStreamingBuffer(target);
        const data = event.data as BashCommandData;
        if (data.command) {
          console.log(chalk.yellow("$ " + data.command));
        }
        if (data.output) {
          process.stdout.write(data.output);
          if (!data.output.endsWith("\n")) process.stdout.write("\n");
        }
        if (data.error) {
          process.stdout.write(chalk.red(data.error));
          if (!data.error.endsWith("\n")) process.stdout.write("\n");
        }
        if (data.exitCode !== undefined && data.exitCode !== 0) {
          console.log(chalk.red("✗ exit " + data.exitCode));
        } else if (data.exitCode === 0) {
          console.log(chalk.green("✓"));
        }
        console.log();
        break;
      }

      case CLI_EVENT_TYPES.FILE_EDIT: {
        CliTerminalFormatter.flushStreamingBuffer(target);
        const data = event.data as FileEditData;
        if (!data.path) break;
        if (data.status === OPERATION_STATUS.INITIATED) {
          console.log(chalk.dim("  ~ Editing " + data.path + "…"));
        } else if (data.status === OPERATION_STATUS.FAILED) {
          const errDetail = data.error ? chalk.dim(" — " + data.error) : "";
          console.log(chalk.red("✗ Edit failed: " + data.path) + errDetail);
          console.log();
        } else {
          console.log(chalk.cyan("~ " + data.path));
          renderDiffBlock(data);
          console.log();
        }
        break;
      }

      case CLI_EVENT_TYPES.FILE_WRITE: {
        CliTerminalFormatter.flushStreamingBuffer(target);
        const data = event.data as FileWriteData;
        if (!data.path) break;
        if (data.status === OPERATION_STATUS.INITIATED) {
          console.log(chalk.dim("  + Writing " + data.path + "…"));
        } else if (data.status === OPERATION_STATUS.FAILED) {
          const errDetail = data.error ? chalk.dim(" — " + data.error) : "";
          console.log(chalk.red("✗ Write failed: " + data.path) + errDetail);
          console.log();
        } else {
          const sizeInfo = data.content
            ? chalk.dim(` (${data.content.length} bytes)`)
            : "";
          console.log(chalk.green("+ " + data.path) + sizeInfo);
          console.log();
        }
        break;
      }

      case CLI_EVENT_TYPES.FILE_READ: {
        CliTerminalFormatter.flushStreamingBuffer(target);
        const data = event.data as FileReadData;
        if (!data.path) break;
        if (data.status === OPERATION_STATUS.INITIATED) {
          // Skip — too noisy during streaming
        } else if (data.status === OPERATION_STATUS.FAILED) {
          const errDetail = data.error ? chalk.dim(" — " + data.error) : "";
          console.log(chalk.red("✗ Read failed: " + data.path) + errDetail);
          console.log();
        } else {
          console.log(chalk.dim("  " + data.path));
        }
        break;
      }

      case CLI_EVENT_TYPES.FILE_DELETE: {
        CliTerminalFormatter.flushStreamingBuffer(target);
        const data = event.data as FileDeleteData;
        if (!data.path) break;
        if (data.success === false) {
          const errDetail = data.error ? chalk.dim(" — " + data.error) : "";
          console.log(chalk.red("✗ Delete failed: " + data.path) + errDetail);
        } else {
          console.log(chalk.red("- " + data.path));
        }
        console.log();
        break;
      }

      case CLI_EVENT_TYPES.MCP_TOOL_CALL: {
        CliTerminalFormatter.flushStreamingBuffer(target);
        const data = event.data as McpToolCallData;
        if (data.server && data.tool) {
          const params = data.parameters
            ? truncateEventText(JSON.stringify(data.parameters), 80)
            : "";
          console.log(
            chalk.magenta("⚙ " + data.server + ":" + data.tool) +
              (params ? " " + chalk.dim(params) : "")
          );
          if (data.result) {
            const text = data.result.success
              ? truncateEventText(data.result.output ?? "Success", 100)
              : truncateEventText(data.result.error ?? "Failed", 200);
            const color = data.result.success ? chalk.dim : chalk.red;
            console.log(color("  ⎿  " + text));
          }
          console.log();
        }
        break;
      }

      case CLI_EVENT_TYPES.WEB_SEARCH: {
        CliTerminalFormatter.flushStreamingBuffer(target);
        const data = event.data as WebSearchData;
        if (data.query) {
          console.log(chalk.blue('⌕ "' + data.query + '"'));
          console.log();
        }
        break;
      }

      case CLI_EVENT_TYPES.TOOL_CALL: {
        CliTerminalFormatter.flushStreamingBuffer(target);
        const data = event.data as ToolCall;
        if (data.name) {
          const params = data.parameters
            ? truncateEventText(JSON.stringify(data.parameters), 80)
            : "";
          console.log(
            chalk.yellow("⚙ " + data.name) +
              (params ? " " + chalk.dim(params) : "")
          );
          if (data.result) {
            const text = data.result.success
              ? truncateEventText(data.result.output ?? "Success", 100)
              : truncateEventText(data.result.error ?? "Failed", 200);
            const color = data.result.success ? chalk.dim : chalk.red;
            console.log(color("  ⎿  " + text));
          }
          console.log();
        }
        break;
      }

      case CLI_EVENT_TYPES.TOOL_RESULT: {
        CliTerminalFormatter.flushStreamingBuffer(target);
        const data = event.data as ToolResultData;
        if (data.result?.output) {
          console.log(
            chalk.dim("  ⎿  " + truncateEventText(data.result.output, 100))
          );
        }
        break;
      }

      case CLI_EVENT_TYPES.ASK_USER_QUESTION: {
        CliTerminalFormatter.flushStreamingBuffer(target);
        const data = event.data as AskUserQuestionData;
        const heading = data.declined
          ? formatAskUserQuestionDecline(data.declined)
          : data.status === OPERATION_STATUS.COMPLETED
            ? `Answered ${formatAskUserQuestionCount(data.questions.length)}`
            : `Asked ${formatAskUserQuestionCount(data.questions.length)}`;
        writeEventLine(chalk.bold(heading));

        for (const [questionIndex, question] of data.questions.entries()) {
          if (questionIndex > 0) writeEventLine(chalk.dim("────────"));
          const header = question.header
            ? chalk.dim(` [${question.header}]`)
            : "";
          const selectedOption = question.options.find(
            (option) => option.label === question.answer
          );
          const questionLines = question.question.split(/\r?\n/);
          writeEventLine(`${questionLines[0]}${header}`);
          for (const line of questionLines.slice(1)) {
            writeEventLine(chalk.dim(`  ${line}`));
          }

          for (const option of question.options) {
            const selected = option.label === question.answer;
            const marker = selected ? chalk.green("✓") : chalk.dim("○");
            const description = option.description
              ? chalk.dim(` — ${option.description}`)
              : "";
            writeEventLine(`  ${marker} ${option.label}${description}`);
            if (option.preview) {
              writeBoundedEventDetail(
                option.preview,
                MAX_EVENT_DETAIL_LINES,
                "    ",
                chalk.cyan
              );
            }
          }

          if (question.answerPreview && !selectedOption?.preview) {
            writeBoundedEventDetail(
              question.answerPreview,
              MAX_EVENT_DETAIL_LINES,
              "    "
            );
          }

          if (question.answer !== undefined) {
            writeEventLine(chalk.dim(`  ⎿ Answer: ${question.answer}`));
          }
          if (question.notes) {
            writeEventLine(chalk.dim(`  ⎿ Note: ${question.notes}`));
          }
        }

        if (data.declined) {
          writeEventLine(
            chalk.red(`  ⎿ ${formatAskUserQuestionDecline(data.declined)}`)
          );
          if (data.declined.feedback) {
            writeBoundedEventDetail(
              data.declined.feedback,
              MAX_EVENT_DETAIL_LINES,
              "    "
            );
          }
        }
        console.log();
        break;
      }

      case CLI_EVENT_TYPES.COMPACTION: {
        CliTerminalFormatter.flushStreamingBuffer(target);
        const data = event.data as CompactionData;
        const tokenInfo =
          data.preTokens !== undefined && data.postTokens !== undefined
            ? ` — ${data.preTokens.toLocaleString()} → ${data.postTokens.toLocaleString()} tokens`
            : data.preTokens !== undefined
              ? ` — ${data.preTokens.toLocaleString()} tokens compacted`
              : "";
        writeEventLine(
          chalk.dim(`Conversation compacted (${data.trigger})${tokenInfo}`),
          chalk.magenta
        );
        if (data.summary) {
          writeBoundedEventDetail(
            data.summary,
            MAX_EVENT_DETAIL_LINES,
            "  ",
            chalk.magenta
          );
        }
        console.log();
        break;
      }

      case CLI_EVENT_TYPES.FOLLOW_UP_RESUMED: {
        CliTerminalFormatter.flushStreamingBuffer(target);
        const data = event.data as FollowUpResumedData;
        const timestamp = data.resumedAt
          ? new Date(data.resumedAt).toLocaleTimeString()
          : "";
        writeEventLine(
          chalk.dim(
            `── Follow-up resumed${timestamp ? ` (${timestamp})` : ""}`
          ),
          chalk.blue
        );
        break;
      }

      case CLI_EVENT_TYPES.BACKGROUND_WORK_HOLD: {
        CliTerminalFormatter.flushStreamingBuffer(target);
        const data = event.data as BackgroundWorkHoldData;
        const timestamp = data.heldAt
          ? new Date(data.heldAt).toLocaleTimeString()
          : "";
        writeEventLine(
          chalk.yellow(
            `⏸ ${getBackgroundWorkHoldHeadline(data)}${timestamp ? ` (${timestamp})` : ""}`
          ),
          chalk.yellow
        );
        for (const task of data.pendingTasks) {
          const { name, meta, command } = getBackgroundTaskLabel(task);
          writeEventLine(
            `  • ${name}${meta ? chalk.dim(` (${meta})`) : ""}`,
            chalk.yellow
          );
          if (command) {
            writeEventLine(chalk.dim(`    $ ${command}`), chalk.yellow);
          }
        }
        break;
      }

      // USER_STEER is display-only and CONTEXT_WINDOW_SYNC is invisible on both
      // sides, so these event types are intentionally left unhandled.
    }
  }

  /**
   * Renders the step header (step N/M, prompt preview) or CLI command line.
   * Called twice per attempt: first without cliCommand (show header + prompt),
   * then with cliCommand (show the harness command being run).
   */
  static renderPromptHeader(data: CliPromptHeaderData): void {
    const {
      stepIndex,
      stepName,
      totalSteps,
      promptText,
      attemptIndex,
      runIndex,
      cliCommand,
    } = data;

    if (cliCommand !== undefined) {
      // Second fire — print the CLI command with a yellow left border (mirrors border-l-output-command-border)
      const cmdBorder = chalk.yellow("│");
      console.log(`${cmdBorder} ${chalk.dim("$ " + cliCommand)}`);
      console.log();
      return;
    }

    // First fire — print step divider, step label, and a prompt preview
    console.log();
    console.log(chalk.dim("─".repeat(52)));

    // Blue left border mirrors border-l-output-prompt-border in the webview
    const border = chalk.blue("│");

    const executionLabel = [
      runIndex > 0 ? `Re-run ${runIndex}` : "",
      attemptIndex > 0 ? `Retry ${attemptIndex}` : "",
    ]
      .filter((label) => label.length > 0)
      .join(" · ");

    if (executionLabel) {
      console.log(
        `${border} ${chalk.yellow(`${executionLabel} — Step ${stepIndex + 1}/${totalSteps} — ${stepName}`)}`
      );
    } else {
      console.log(
        `${border} ${chalk.bold(`Step ${stepIndex + 1}/${totalSteps} — ${stepName}`)}`
      );
    }

    if (data.harness) {
      console.log(
        `${border} ${chalk.dim("Harness: ")}${chalk.yellow(data.harness)}`
      );
    }
    if (data.model) {
      console.log(`${border} ${chalk.dim("Model: ")}${chalk.dim(data.model)}`);
    }

    // Show a bounded prompt preview; the complete prompt remains in events.jsonl.
    const lines = promptText.trimEnd().split("\n");
    const previewLines = lines.slice(0, MAX_PREVIEW_LINES);
    const truncated = lines.length > MAX_PREVIEW_LINES;
    for (const line of previewLines) {
      console.log(`${border} ${chalk.dim(line)}`);
    }
    if (truncated) {
      console.log(
        `${border} ${chalk.dim(
          formatTruncationNotice(
            `${lines.length - previewLines.length} more lines`
          )
        )}`
      );
    }
    console.log();
  }

  /**
   * Renders a workflow status message (end condition result, retry notification, etc.)
   * using severity-appropriate chalk colour.
   */
  static renderStatusMessage(message: string, severity: string): void {
    if (severity === STATUS_MESSAGE_SEVERITY.ERROR) {
      // Red left border mirrors border-l-severity-error in the webview
      console.log(`${chalk.red("│")} ${chalk.red("✗ " + message)}`);
    } else if (severity === STATUS_MESSAGE_SEVERITY.WARNING) {
      // Yellow left border mirrors border-l-severity-warning in the webview
      console.log(`${chalk.yellow("│")} ${chalk.yellow("⚠ " + message)}`);
    } else {
      // Cyan left border mirrors border-l-severity-info in the webview
      console.log(`${chalk.cyan("│")} ${chalk.dim("ℹ " + message)}`);
    }
  }

  /**
   * Renders per-prompt statistics (tokens, session ID, elapsed time) to stdout
   * after a prompt completes, mirroring the stats section of the webview's CliOutput component.
   */
  static renderStats(data: PromptCompleteData): void {
    const parts: string[] = [];

    if (data.tokens) {
      const {
        prompt,
        completion,
        cached,
        cacheCreated,
        contextWindowUsed,
        contextWindowSize,
        total: reportedTotal,
        compactionCount,
        cost,
      } = data.tokens;
      const total = resolveTokenTotal(reportedTotal, prompt, completion);
      const totalLabel = formatTokenCount(total);
      const tokenBreakdown = formatTokenBreakdown({
        input: prompt,
        output: completion,
        total: reportedTotal,
        harness: data.harness,
        cached,
        cacheCreated,
      });
      const compactionLabel =
        compactionCount !== undefined && compactionCount > 0
          ? `Compacted ${compactionCount}x`
          : undefined;

      if (contextWindowUsed !== undefined && contextWindowSize) {
        const pct = Math.round((contextWindowUsed / contextWindowSize) * 100);
        const contextParts = [
          `Context: ${formatTokenCount(contextWindowUsed)}/${formatTokenCount(contextWindowSize)} (${pct}%)`,
          totalLabel ? TOKEN_USAGE_SCOPE_NOTE : null,
          totalLabel && isCacheInputSubset(data.harness)
            ? TOKEN_TOTAL_CACHE_NETTED_NOTE
            : null,
          totalLabel ? `Total: ${totalLabel}` : null,
          data.hideCost || !cost
            ? null
            : `${formatCostLabel(cost.usd)} ${formatCostSourcePhrase([cost.source])}`,
          compactionLabel ?? null,
        ].filter((part): part is string => part !== null);
        parts.push(contextParts.join("  "));
      } else {
        const tokenParts = [
          tokenBreakdown || null,
          totalLabel && isCacheInputSubset(data.harness)
            ? TOKEN_TOTAL_CACHE_NETTED_NOTE
            : null,
          data.hideCost || !cost
            ? null
            : `${formatCostLabel(cost.usd)} ${formatCostSourcePhrase([cost.source])}`,
          compactionLabel ?? null,
        ].filter((part): part is string => part !== null);
        if (tokenParts.length > 0) {
          parts.push(tokenParts.join("  "));
        } else if (totalLabel) {
          parts.push(`Total: ${totalLabel}`);
        }
      }
    }

    if (data.sessionId) {
      const harnessLabel = data.harness ? ` (${data.harness})` : "";
      parts.push(`Session${harnessLabel}: ${data.sessionId}`);
    }

    if (data.elapsed !== undefined) {
      parts.push(`${data.elapsed}s`);
    }

    if (parts.length > 0) {
      console.log();
      console.log(chalk.dim(parts.join(" | ")));
    }
  }
}

function formatDiagnosticSeverity(severity: string): string {
  return `[${severity}]`;
}
