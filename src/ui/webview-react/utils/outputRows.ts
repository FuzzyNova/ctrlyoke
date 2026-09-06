import type { WorkflowStep } from "@store/workflowStore";
import {
  CLI_EVENT_TYPES,
  FINAL_STEP_PHASES,
  OUTPUT_ACTIVITY_KINDS,
  getStreamingChunkKey,
  type ExecutionPhase,
} from "../types/messages";
import type {
  AskUserQuestionData,
  CliOutput as CliOutputType,
  CliEvent,
  McpToolCallData,
  OutputStatusMessage,
  ToolCall,
} from "../types/cliEvents";
import type {
  ParallelGroupDefinition,
  ScriptVerdict,
} from "@root/types/CtrlYokeTypes";
import {
  OUTPUT_ROW_KINDS,
  OUTPUT_MESSAGE_TYPES,
  OPERATION_STATUS,
  STEP_COLOR_MODES,
  WORKFLOW_TOKEN_COVERAGE,
  STEP_TYPES,
  type HarnessId,
  type OutputRowKind,
  type WorkflowTokenCoverage,
} from "@root/types/DashboardConstants";
import type {
  StepOutput,
  UndoRecord,
  WorkspaceSnapshot,
  WorkflowOutputHistory,
  WorkflowRunMetadata,
} from "@root/types/OutputHistoryTypes";
import { sanitizeTerminalOutput } from "@root/utils/TerminalOutputSanitizer";
import { resolveTokenTotal } from "@root/utils/TokenFormatting";
import type { OutputMessage, OutputMessageTarget } from "./outputProjection";
import { getTargetKey } from "./outputProjection";
import { computePromptUndoActions } from "./promptUndo";
import {
  buildUndoRecordKey,
  computeOutputDiffStats,
  getCliTextForCopy,
  getOutputDiffKey,
  getRawTextOutput,
  getVisibleStructuredEvents,
  isScriptOutput,
} from "./outputRenderUtils";
import type { DiffGapExpansionState } from "./outputRenderUtils";
import {
  DEFAULT_TOOL_CALL_EXPANSION_STATE,
  buildToolCallRenderPlan,
  estimateGenericToolCallHeight,
  type ToolCallRenderPlan,
  type ToolCallExpansionState,
} from "./toolCallLayout";
import {
  DEFAULT_COLLAPSED_COMMAND_MAX_CHARS,
  DEFAULT_COLLAPSED_OUTPUT_MAX_CHARS,
  DEFAULT_COLLAPSED_OUTPUT_MAX_LINES,
  SCRIPT_OUTPUT_LINES_PER_ROW,
  buildCollapsedSingleLinePreview,
  buildCollapsedOutputPreview,
  getCollapsedOutputMaxChars,
  splitTextIntoLineSegments,
  takeTrailingLines,
} from "./outputTruncation";
import { formatCliCommandDisplay } from "./outputCommandDisplay";
import {
  OUTPUT_ROW_HORIZONTAL_PADDING,
  OUTPUT_SECTION_HEADER_NARROW_THRESHOLD,
  TOOL_CALL_BLOCK_HALF_VERTICAL_CHROME,
  TOOL_CALL_BLOCK_VERTICAL_CHROME,
  estimateFileOperationHeaderLines,
  outputRowActivityChrome,
  outputRowGroupPadding,
  resolveOutputContentWidth,
  toolCallGutterWidth,
  toolCallLineHeight,
  toolResultLineHeight,
  toolResultPrefixWidth,
} from "./outputLineMetrics";
import type { DiffRenderPlan } from "./rdvAdapter";
import { resolveStepColor } from "./stepColor";
import type { HarnessColorSettings } from "@root/types/CtrlYokeSettings";
import type { StepColorMode } from "@root/types/DashboardConstants";

export interface OutputRowPromptUndoAction {
  label: string;
  count: number;
}

export interface OutputRowPromptUndoMeta {
  workspacePath: string;
  workspaceSnapshot?: WorkspaceSnapshot;
  undoRecord?: UndoRecord;
  allStepOutputs: CliOutputType[];
  undo: OutputRowPromptUndoAction | null;
  redo: OutputRowPromptUndoAction | null;
}

export interface OutputRowDiffMeta {
  key: string;
  addedLines: number;
  removedLines: number;
  runs: Array<{
    count: number;
    addedLines: number;
    removedLines: number;
  }>;
  isCollapsed: boolean;
  expandedGaps?: DiffGapExpansionState;
  renderPlan: DiffRenderPlan;
}

export interface OutputRowToolCallMeta {
  expansion: ToolCallExpansionState;
  renderPlan: ToolCallRenderPlan;
}

export interface OutputRowBashExpansionState {
  commandExpanded: boolean;
  outputExpanded: boolean;
  errorExpanded: boolean;
}

const STEP_HIDDEN_ROW_HEIGHT = 40;

export interface OutputRowBase<TRowKind extends OutputRowKind = OutputRowKind> {
  key: string;
  rowKind: TRowKind;
  target: OutputMessageTarget;
  estimateSize: number;
  groupStart?: boolean;
  groupEnd?: boolean;
  promptUndo?: OutputRowPromptUndoMeta;
  activityKey?: string;
  activityFirst?: boolean;
  activityLabel?: string;
  activityName?: string;
  /** Identity color painted by OutputRow's inset gutter bar. */
  stepColor?: string;
}

export interface AttemptGroupSummaryRow extends OutputRowBase<
  typeof OUTPUT_ROW_KINDS.ATTEMPT_GROUP_SUMMARY
> {
  target: OutputMessageTarget;
  groupKey: string;
  attemptCount: number;
  total?: number;
  coverage: WorkflowTokenCoverage;
}

export interface StepAnchorRow extends OutputRowBase<
  typeof OUTPUT_ROW_KINDS.STEP_ANCHOR
> {
  target: OutputMessageTarget;
}

export interface StepHiddenRow extends OutputRowBase<
  typeof OUTPUT_ROW_KINDS.STEP_HIDDEN
> {
  target: OutputMessageTarget;
  stepLabel: string;
  stepName?: string;
}

export interface FinalStepLabelRow extends OutputRowBase<
  typeof OUTPUT_ROW_KINDS.FINAL_STEP_LABEL
> {
  target: OutputMessageTarget;
  label: string;
}

export interface StatusRow extends OutputRowBase<
  typeof OUTPUT_ROW_KINDS.STATUS
> {
  target: OutputMessageTarget;
  status: OutputStatusMessage;
}

export interface CliHeaderRow extends OutputRowBase<
  typeof OUTPUT_ROW_KINDS.CLI_HEADER
> {
  target: OutputMessageTarget;
  output: CliOutputType;
  stepIndex: number;
  isFinalStep: boolean;
  stepLabel: string;
  stepName?: string;
  attemptIndex: number;
  runIndex: number;
  promptUndo?: OutputRowPromptUndoMeta;
}

export interface PromptRow extends OutputRowBase<
  typeof OUTPUT_ROW_KINDS.PROMPT
> {
  target: OutputMessageTarget;
  text: string;
}

interface CommandRowBase<
  TRowKind extends OutputRowKind,
> extends OutputRowBase<TRowKind> {
  target: OutputMessageTarget;
  workingDirectory?: string;
  command: string;
  wasInjected?: boolean;
}

export interface CliCommandRow extends CommandRowBase<
  typeof OUTPUT_ROW_KINDS.CLI_COMMAND
> {}

export interface ScriptCommandRow extends CommandRowBase<
  typeof OUTPUT_ROW_KINDS.SCRIPT_COMMAND
> {}

export interface ErrorRow extends OutputRowBase<typeof OUTPUT_ROW_KINDS.ERROR> {
  target: OutputMessageTarget;
  timestamp?: string;
  errorMessage: string;
}

export interface StructuredEventRow extends OutputRowBase<
  typeof OUTPUT_ROW_KINDS.STRUCTURED_EVENT
> {
  target: OutputMessageTarget;
  event: CliEvent;
  eventIndex: number;
  rawTextOutput: boolean;
  attemptIndex: number;
  workspaceSnapshot?: WorkspaceSnapshot;
  undoRecord?: UndoRecord;
  diff?: OutputRowDiffMeta;
  toolCall?: OutputRowToolCallMeta;
  /** Whether dense tool-call header toggles have room for their text label. */
  showParamsLabel?: boolean;
  bashExpansion?: OutputRowBashExpansionState;
  collapsedToolOutputLineCount?: number;
  /** Width-aware character budget backing the collapsed Bash preview. */
  collapsedToolOutputMaxCharacters?: number;
  hideDiff: boolean;
}

export interface PlainResponseRow extends OutputRowBase<
  typeof OUTPUT_ROW_KINDS.PLAIN_RESPONSE
> {
  target: OutputMessageTarget;
  text: string;
  rawTextOutput: boolean;
  animated: boolean;
}

/**
 * One slice of a script's stdout/stderr.
 *
 * Script output is plain text with no structured events, so it used to render
 * as a single `plain-response` row holding the entire accumulated output. That
 * row is indivisible: the virtualizer cannot page it, every append re-lays-out
 * every character already on screen, and a chatty `npm test` reached hundreds
 * of KB — enough to wedge the pane in a measure/render loop for minutes after
 * the process had already exited. Slicing it into bounded rows makes each
 * append touch one row's DOM and lets virtualization do its job.
 */
export interface ScriptOutputRow extends OutputRowBase<
  typeof OUTPUT_ROW_KINDS.SCRIPT_OUTPUT
> {
  target: OutputMessageTarget;
  text: string;
  /** Position within the emitted slices; only the ends carry block padding. */
  isFirstSegment: boolean;
  isLastSegment: boolean;
  /**
   * Present on the last emitted slice when output is being withheld, or when
   * the user expanded it and can collapse again. Keyed separately from the row
   * because which row carries the toggle changes with the expansion state.
   */
  tailToggle?: {
    key: string;
    hiddenLineCount: number;
    expanded: boolean;
  };
}

export interface StatsRow extends OutputRowBase<typeof OUTPUT_ROW_KINDS.STATS> {
  target: OutputMessageTarget;
  output: CliOutputType;
  outputText?: string;
}

export interface ScriptVerdictRow extends OutputRowBase<
  typeof OUTPUT_ROW_KINDS.SCRIPT_VERDICT
> {
  target: OutputMessageTarget;
  verdict: ScriptVerdict;
  expanded: boolean;
}

export type OutputRenderRow =
  | StepAnchorRow
  | StepHiddenRow
  | FinalStepLabelRow
  | StatusRow
  | CliHeaderRow
  | PromptRow
  | CliCommandRow
  | ScriptCommandRow
  | ErrorRow
  | StructuredEventRow
  | PlainResponseRow
  | ScriptOutputRow
  | ScriptVerdictRow
  | AttemptGroupSummaryRow
  | StatsRow;

export interface BuildOutputRowsInput {
  allMessages: readonly OutputMessage[];
  steps: readonly WorkflowStep[];
  finalStep: WorkflowStep | null | undefined;
  parallelGroups?: readonly ParallelGroupDefinition[];
  /** Workflow-level fallback for prompt-step harness resolution. */
  effectiveHarness?: HarnessId;
  /** Dashboard-only per-harness identity color settings. */
  stepColorMode?: StepColorMode;
  harnessColorSettings?: HarnessColorSettings;
  streamingChunks: Record<string, string>;
  finalStepStreamingChunks: Record<string, string>;
  isExecutionActive: boolean;
  allowUndoActions: boolean;
  isViewingHistory: boolean;
  historyOutputs: {
    orderedEntries: WorkflowOutputHistory["orderedEntries"];
    promptOutputs: Record<number, StepOutput>;
    finalStepOutputs?: Record<number, StepOutput>;
    runMetadata: WorkflowRunMetadata;
  } | null;
  workspaceSnapshots: Record<number, WorkspaceSnapshot | undefined>;
  finalStepWorkspaceSnapshots: Record<number, WorkspaceSnapshot | undefined>;
  undoRecords: Record<string, UndoRecord | undefined>;
  diffCollapseState: ReadonlyMap<string, boolean>;
  diffExpansionState: ReadonlyMap<string, DiffGapExpansionState>;
  toolCallExpansionState: ReadonlyMap<string, ToolCallExpansionState>;
  bashExpansionState?: ReadonlyMap<string, OutputRowBashExpansionState>;
  scriptVerdictExpansionState?: ReadonlyMap<string, boolean>;
  /** Keyed by `ScriptOutputRow.tailToggle.key`, not by row key. */
  scriptOutputExpansionState?: ReadonlyMap<string, boolean>;
  /** Retry/manual-rerun groups currently shown as one aggregate row. */
  collapsedAttemptGroupKeys?: ReadonlySet<string>;
  /** Steps whose content is replaced by one StepHiddenRow. */
  hiddenTargetKeys?: ReadonlySet<string>;
  defaultDiffCollapsed: boolean;
  diffViewType?: "split" | "unified";
  outputFontSize?: number;
  outputContentWidth?: number;
  /** Approximate number of wrapped result lines shown before Bash and generic tool output collapses. */
  collapsedToolOutputLineCount?: number;
}

export function getParallelGroupForStep(
  parallelGroups: readonly ParallelGroupDefinition[] | undefined,
  stepIndex: number
): ParallelGroupDefinition | undefined {
  const group = parallelGroups?.find(
    (candidate) =>
      stepIndex >= candidate.startIndex && stepIndex <= candidate.endIndex
  );
  return group && group.startIndex !== group.endIndex ? group : undefined;
}

type ConcurrentGroupInput = Pick<
  BuildOutputRowsInput,
  | "parallelGroups"
  | "isViewingHistory"
  | "historyOutputs"
  | "workspaceSnapshots"
>;

export function getConcurrentGroupForStep(
  input: ConcurrentGroupInput,
  stepIndex: number
): ParallelGroupDefinition | undefined {
  const group = getParallelGroupForStep(input.parallelGroups, stepIndex);
  if (!group) return undefined;
  const groupSnapshot =
    input.isViewingHistory && input.historyOutputs
      ? input.historyOutputs.promptOutputs[group.startIndex]?.workspaceSnapshot
      : input.workspaceSnapshots[group.startIndex];
  return groupSnapshot?.parallelGroupId === group.id ? group : undefined;
}

/** Identity of one attempt's row block: `<target>:run<n>:attempt<n>`. */
function getAttemptRowKeyBase(
  targetKey: string,
  runIndex: number,
  attemptIndex: number
): string {
  return `${targetKey}:run${runIndex}:attempt${attemptIndex}`;
}

/**
 * Row-key namespace for the rows a single message contributes.
 *
 * **Every row key must be unique across the whole list.** The virtualizer keys
 * its measurement cache by `row.key` (`getItemKey`) and React keys the DOM by
 * it, so two rows sharing a key each adopt the other's measured height: the
 * pane renders large gaps, jumps while scrolling, and the measure -> setState
 * -> re-measure cycle can fail to converge until React throws #185 ("Maximum
 * update depth exceeded") and takes the whole dashboard down.
 *
 * The attempt identity alone stopped being unique once the chronological
 * activity projection landed. It slices one attempt into many messages, and
 * each slice's `activityEvents` is its own array whose `originalIndex` restarts
 * at 0 — so every slice of an attempt produced the same `:header`, `:event:0`
 * and `:stats` keys. Slices are therefore namespaced by their `activityKey`,
 * which `mapOrderedHistoryEntriesToMessages` already assigns uniquely.
 */
function getRowKeyBase(
  attemptRowKeyBase: string,
  message: OutputMessage
): string {
  return message.isActivity && message.activityKey
    ? `${attemptRowKeyBase}:activity:${message.activityKey}`
    : attemptRowKeyBase;
}

interface AttemptGroupAggregate {
  key: string;
  target: OutputMessageTarget;
  firstMessageIndex: number;
  attempts: Map<string, CliOutputType>;
}

function getAttemptGroupKey(message: OutputMessage): string | undefined {
  if (message.type !== OUTPUT_MESSAGE_TYPES.CLI) return undefined;
  const output = message.data as CliOutputType;
  const runIndex = message.runIndex ?? output.runIndex ?? 0;
  return `${getTargetKey(message.target)}:run${runIndex}`;
}

/** Finds the retry/manual-rerun groups eligible for a collapsed summary. */
export function getCollapsibleAttemptGroupKeys(
  messages: readonly OutputMessage[]
): ReadonlySet<string> {
  const groups = new Map<string, Set<string>>();
  for (const message of messages) {
    const groupKey = getAttemptGroupKey(message);
    if (!groupKey || message.type !== OUTPUT_MESSAGE_TYPES.CLI) continue;
    const attemptKey = `${groupKey}:attempt${message.attemptIndex ?? 0}`;
    const attempts = groups.get(groupKey) ?? new Set<string>();
    attempts.add(attemptKey);
    groups.set(groupKey, attempts);
  }

  return new Set(
    [...groups.entries()]
      .filter(([, attempts]) => attempts.size > 1)
      .map(([groupKey]) => groupKey)
  );
}

export interface BuildOutputRowsResult {
  rows: OutputRenderRow[];
  uniqueStepTargets: OutputMessageTarget[];
  stepOutputsMap: Map<string, CliOutputType[]>;
  lastCliIndexPerStep: Map<string, number>;
  firstRowIndexByTarget: Map<string, number>;
  anchorRowIndexByTarget: Map<string, number>;
  latestActivityRowKey?: string;
}

function getStepName(
  step: WorkflowStep | null | undefined,
  fallback: string
): string {
  const name = step?.name?.trim();
  return name || fallback;
}

function getEffectiveStepHarness(
  step: WorkflowStep,
  effectiveHarness: HarnessId | undefined
): HarnessId | undefined {
  // Runtime metadata is authoritative for started steps: changing workflow
  // defaults while viewing a run must not recolor its existing output.
  if (step.type === STEP_TYPES.SCRIPT) return undefined;
  return (step._runtime?.harness ?? step.harness ?? effectiveHarness) as
    | HarnessId
    | undefined;
}

function getStepOutputArtifacts(
  input: BuildOutputRowsInput,
  target: OutputMessageTarget
): {
  workspaceSnapshot?: WorkspaceSnapshot;
  undoRecord?: UndoRecord;
} {
  if (input.isViewingHistory && input.historyOutputs) {
    const stepOutput =
      target.kind === FINAL_STEP_PHASES.QUEUE
        ? input.historyOutputs.promptOutputs[target.index]
        : input.historyOutputs.finalStepOutputs?.[target.index];
    return {
      workspaceSnapshot: stepOutput?.workspaceSnapshot,
      undoRecord: stepOutput?.undoRecord,
    };
  }

  return {
    workspaceSnapshot:
      target.kind === FINAL_STEP_PHASES.QUEUE
        ? input.workspaceSnapshots[target.index]
        : input.finalStepWorkspaceSnapshots[target.index],
    undoRecord: input.undoRecords[buildUndoRecordKey(target)],
  };
}

function getStreamingChunk(
  input: BuildOutputRowsInput,
  target: OutputMessageTarget,
  phase?: ExecutionPhase,
  runIndex = 0,
  attemptIndex = 0
): string {
  return target.kind === FINAL_STEP_PHASES.QUEUE
    ? input.streamingChunks[
        getStreamingChunkKey(
          target.index,
          phase,
          runIndex,
          attemptIndex,
          OUTPUT_ACTIVITY_KINDS.TEXT,
          FINAL_STEP_PHASES.QUEUE
        )
      ] || ""
    : input.finalStepStreamingChunks[
        getStreamingChunkKey(
          target.index,
          phase,
          runIndex,
          attemptIndex,
          OUTPUT_ACTIVITY_KINDS.TEXT,
          FINAL_STEP_PHASES.FINAL_STEP
        )
      ] || "";
}

/**
 * Calibrated horizontal allowance for *prose* rows (markdown, plain responses,
 * thinking, status). It is deliberately much larger than the row's real
 * padding: it also absorbs markdown's own block indents and the
 * proportional-glyph error left over from estimating rendered text by character
 * count. Rows inside a ● block have exact geometry instead — use
 * OUTPUT_ROW_HORIZONTAL_PADDING there, not this.
 */
const OUTPUT_ROW_HORIZONTAL_CHROME = 72;
const HEADER_HORIZONTAL_CHROME = 140;
const STATS_HORIZONTAL_CHROME = 96;
const OUTPUT_BLOCK_VERTICAL_CHROME = 32;
const THINKING_LABEL_HEIGHT = 18;
const THINKING_CONTENT_VERTICAL_CHROME = 14;
const THINKING_OUTER_VERTICAL_CHROME = 6;
const STATUS_ROW_VERTICAL_CHROME = 20;
const HEADER_VERTICAL_CHROME = 11; // pb-spacing-xs(4) + border-b(1) + mb-spacing-sm(6)
const STATS_VERTICAL_CHROME = 10;
const BASH_RESULT_MAX_CHARS = DEFAULT_COLLAPSED_OUTPUT_MAX_CHARS;

function normalizeTextForLayout(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\t/g, "    ");
}

function resolveContentWidth(
  outputContentWidth?: number,
  chrome = OUTPUT_ROW_HORIZONTAL_CHROME
): number {
  return resolveOutputContentWidth(outputContentWidth, chrome);
}

/**
 * Counting wrapped lines is O(text length) — two full-string regex passes plus
 * a split — and `estimateOutputRowHeight` is called several times per render
 * for the same row (the virtualizer's `estimateSize`, the `rowLayout` model,
 * and measurement reconciliation). That repetition is free for ordinary rows
 * but dominates when a row holds a streaming script's entire output, which is
 * a single unbounded row that can reach hundreds of KB.
 *
 * Cache only large texts: small rows are cheap to recount and would evict the
 * one entry that matters. Keyed on the text itself — repeated lookups with the
 * same string reference are cheap once V8 has cached its hash — with the layout
 * parameters stored alongside and revalidated, since they change far less often
 * than the text does.
 */
const WRAPPED_LINE_COUNT_CACHE_MIN_CHARS = 4096;
const WRAPPED_LINE_COUNT_CACHE_MAX_ENTRIES = 16;

interface WrappedLineCountCacheEntry {
  charsPerLine: number;
  emptyLineWeight: number;
  wrapAtWords: boolean;
  count: number;
}

const wrappedLineCountCache = new Map<string, WrappedLineCountCacheEntry>();

function countWrappedLines(
  text: string,
  charsPerLine: number,
  emptyLineWeight: number,
  wrapAtWords: boolean
): number {
  return normalizeTextForLayout(text)
    .split("\n")
    .reduce((total, rawLine) => {
      if (rawLine.length === 0) {
        return total + emptyLineWeight;
      }
      if (wrapAtWords) {
        return total + countPreWrappedLineSegments(rawLine, charsPerLine);
      }
      return total + Math.max(1, Math.ceil(rawLine.length / charsPerLine));
    }, 0);
}

/**
 * Approximate `white-space: pre-wrap` plus `overflow-wrap: anywhere`.
 *
 * The browser prefers a whitespace break before falling back to an arbitrary
 * character break. Treating every prose line as perfectly packed therefore
 * under-counts narrow prompt and CLI-command rows by roughly 20%: unused space
 * at each word boundary accumulates over dozens of visual lines.
 */
function countPreWrappedLineSegments(
  rawLine: string,
  charsPerLine: number
): number {
  const words = rawLine.trim().split(/\s+/);
  if (words.length === 0 || (words.length === 1 && words[0] === "")) {
    return 1;
  }

  let lines = 1;
  let usedColumns = 0;
  for (const word of words) {
    if (word.length <= charsPerLine) {
      const separatorColumns = usedColumns === 0 ? 0 : 1;
      if (usedColumns + separatorColumns + word.length <= charsPerLine) {
        usedColumns += separatorColumns + word.length;
      } else {
        lines += 1;
        usedColumns = word.length;
      }
      continue;
    }

    let remainingWordColumns = word.length;
    if (usedColumns > 0) {
      const availableColumns = Math.max(0, charsPerLine - usedColumns - 1);
      remainingWordColumns -= availableColumns;
      lines += 1;
    }
    lines += Math.floor((remainingWordColumns - 1) / charsPerLine);
    usedColumns = ((remainingWordColumns - 1) % charsPerLine) + 1;
  }
  return lines;
}

function estimateWrappedLineCount(
  text: string,
  outputContentWidth: number | undefined,
  outputFontSize: number,
  options?: {
    chrome?: number;
    charWidthMultiplier?: number;
    // How much vertical weight to give empty lines (paragraph separators).
    // Default 1.0 counts them as full lines. Use 0.5 for markdown where \n\n
    // renders as a compact paragraph margin rather than a blank line.
    emptyLineWeight?: number;
    wrapAtWords?: boolean;
  }
): number {
  if (text.length === 0) {
    return 0;
  }

  const availableWidth = resolveContentWidth(
    outputContentWidth,
    options?.chrome ?? OUTPUT_ROW_HORIZONTAL_CHROME
  );
  const charWidth = Math.max(
    5.5,
    outputFontSize * (options?.charWidthMultiplier ?? 0.62)
  );
  const charsPerLine = Math.max(8, Math.floor(availableWidth / charWidth));
  const emptyLineWeight = options?.emptyLineWeight ?? 1.0;
  const wrapAtWords = options?.wrapAtWords ?? false;

  if (text.length < WRAPPED_LINE_COUNT_CACHE_MIN_CHARS) {
    return countWrappedLines(text, charsPerLine, emptyLineWeight, wrapAtWords);
  }

  const cached = wrappedLineCountCache.get(text);
  if (
    cached &&
    cached.charsPerLine === charsPerLine &&
    cached.emptyLineWeight === emptyLineWeight &&
    cached.wrapAtWords === wrapAtWords
  ) {
    return cached.count;
  }

  const count = countWrappedLines(
    text,
    charsPerLine,
    emptyLineWeight,
    wrapAtWords
  );
  // Map preserves insertion order, so the first key is the oldest entry.
  if (
    !cached &&
    wrappedLineCountCache.size >= WRAPPED_LINE_COUNT_CACHE_MAX_ENTRIES
  ) {
    const oldest = wrappedLineCountCache.keys().next();
    if (!oldest.done) {
      wrappedLineCountCache.delete(oldest.value);
    }
  }
  wrappedLineCountCache.set(text, {
    charsPerLine,
    emptyLineWeight,
    wrapAtWords,
    count,
  });
  return count;
}

function estimateTextBlockHeight(
  text: string,
  outputContentWidth: number | undefined,
  outputFontSize: number,
  options?: {
    chrome?: number;
    verticalChrome?: number;
    charWidthMultiplier?: number;
    lineHeightMultiplier?: number;
    emptyLineWeight?: number;
    wrapAtWords?: boolean;
  }
): number {
  const lineCount = estimateWrappedLineCount(
    text,
    outputContentWidth,
    outputFontSize,
    {
      chrome: options?.chrome,
      charWidthMultiplier: options?.charWidthMultiplier,
      emptyLineWeight: options?.emptyLineWeight,
      wrapAtWords: options?.wrapAtWords,
    }
  );
  if (lineCount === 0) {
    return 0;
  }

  const lineHeight = Math.max(
    16,
    outputFontSize * (options?.lineHeightMultiplier ?? 1.55)
  );
  return (
    lineCount * lineHeight +
    (options?.verticalChrome ?? OUTPUT_BLOCK_VERTICAL_CHROME)
  );
}

// ── Markdown table layout (streamdown's renderer) ──────────────────────────
// Streamdown wraps every table in a bordered card with a control bar (copy /
// download / fullscreen buttons) and an overflow-x-auto scroll region:
//   <div class="my-4 ... rounded-lg border p-2">      ← wrapper
//     <div class="...justify-end gap-1">...buttons</div> ← control bar
//     <div class="overflow-x-auto ... border rounded"> ← scroll region
//       <table class="w-full divide-y">                ← th: nowrap px-4 py-2
// Cells use px-4 (32px horizontal) / py-2 (16px vertical) padding, header cells
// are whitespace-nowrap (always one line), body cells wrap.
const TABLE_CELL_HPAD = 32; // px-4 left + right
const TABLE_CELL_VCHROME = 17; // py-2 (16) + divide-y border (1)
// my-4 (32) + p-2 (16) + gap-2 (8) + control bar (~26) + inner/outer borders (4)
const TABLE_WRAPPER_VCHROME = 86;
const TABLE_WRAPPER_HCHROME = 20; // p-2 (16) + inner + outer borders (4)
// When a many-column table overflows the pane, the browser crams columns far
// below their natural width. Empirically (10-col real-world table measured at
// 3747px) columns settle around ~7-8 characters wide; 7.5 lands the estimate at
// ~3900px (+4%, intentionally a touch high — under-estimates cause scroll jumps).
const TABLE_OVERFLOW_COL_CHARS = 7.5;

// Mermaid fenced blocks auto-render to a diagram (see MermaidBlock) whose height
// can't be derived from the source text. Use a flat per-diagram estimate (header
// bar + a typical diagram); the virtualizer corrects to the real measured height
// once the row is realized.
const MERMAID_DIAGRAM_ESTIMATED_HEIGHT = 280;

function isTableRowLine(line: string): boolean {
  return line.trim().startsWith("|");
}

function isTableSeparatorLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    /^\|?[\s:|-]+\|?$/.test(trimmed) &&
    trimmed.includes("-") &&
    trimmed.includes("|")
  );
}

function parseTableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

/**
 * Estimates the rendered height of a single streamdown markdown table. Models
 * CSS auto table-layout: columns size between their min-content (longest word)
 * and max-content (longest cell) width, clamped to the available pane width;
 * when the table overflows, columns are capped narrow and body cells wrap. Row
 * height is driven by the tallest cell in each row.
 */
function estimateMarkdownTableHeight(
  blockLines: string[],
  outputContentWidth: number | undefined,
  outputFontSize: number
): number {
  const rows = blockLines.filter(isTableRowLine);
  if (rows.length < 1) {
    return 0;
  }
  const header = parseTableCells(rows[0]);
  const body = rows
    .slice(1)
    .filter((line) => !isTableSeparatorLine(line))
    .map(parseTableCells);
  const columnCount = Math.max(
    header.length,
    ...body.map((cells) => cells.length),
    1
  );

  const charWidth = Math.max(5.5, outputFontSize * 0.6);
  const lineHeight = Math.max(16, outputFontSize * 1.5);
  const availableWidth =
    resolveContentWidth(outputContentWidth, OUTPUT_ROW_HORIZONTAL_CHROME) -
    TABLE_WRAPPER_HCHROME;
  const overflowColWidth =
    TABLE_CELL_HPAD + TABLE_OVERFLOW_COL_CHARS * charWidth;

  // Per-column min-content (longest unbreakable word; header is nowrap so its
  // whole text counts) and max-content (longest cell) widths, in pixels.
  const minWidths: number[] = [];
  const maxWidths: number[] = [];
  for (let c = 0; c < columnCount; c++) {
    const headerText = header[c] ?? "";
    let longestWord = headerText.length;
    let longestCell = headerText.length;
    for (const cells of body) {
      const cell = cells[c] ?? "";
      longestCell = Math.max(longestCell, cell.length);
      for (const word of cell.split(/\s+/)) {
        longestWord = Math.max(longestWord, word.length);
      }
    }
    minWidths.push(longestWord * charWidth + TABLE_CELL_HPAD);
    maxWidths.push(longestCell * charWidth + TABLE_CELL_HPAD);
  }
  const sumMin = minWidths.reduce((a, b) => a + b, 0);
  const sumMax = maxWidths.reduce((a, b) => a + b, 0);

  let columnWidths: number[];
  if (sumMax <= availableWidth) {
    // Table fits at full width — every cell renders on a single line.
    columnWidths = maxWidths;
  } else if (sumMin >= availableWidth) {
    // Table overflows even at min-content — columns are crammed/capped narrow.
    columnWidths = minWidths.map((w) => Math.min(w, overflowColWidth));
  } else {
    // Distribute the slack between min and max proportionally (CSS auto layout).
    const slack = availableWidth - sumMin;
    const span = sumMax - sumMin || 1;
    columnWidths = minWidths.map(
      (w, i) => w + (slack * (maxWidths[i] - w)) / span
    );
  }
  const charsPerColumn = columnWidths.map((w) =>
    Math.max(1, Math.floor((w - TABLE_CELL_HPAD) / charWidth))
  );

  // Header is nowrap → exactly one line. Each body row is as tall as its
  // tallest (most-wrapped) cell.
  let height = lineHeight + TABLE_CELL_VCHROME;
  for (const cells of body) {
    let rowLines = 1;
    for (let c = 0; c < columnCount; c++) {
      const cellLength = (cells[c] ?? "").length;
      rowLines = Math.max(rowLines, Math.ceil(cellLength / charsPerColumn[c]));
    }
    height += rowLines * lineHeight + TABLE_CELL_VCHROME;
  }
  return height + TABLE_WRAPPER_VCHROME;
}

function estimateMarkdownBlockHeight(
  text: string,
  outputContentWidth: number | undefined,
  outputFontSize: number
): number {
  // Split the text into prose and table blocks. Tables render through
  // streamdown's bordered table card with its own column-wrapping behavior, so
  // they need a dedicated estimator — wrapping them as plain full-width text
  // (as the base estimate does) under-counts the height of narrow columns by 3×.
  const lines = normalizeTextForLayout(text).split("\n");
  const proseLines: string[] = [];
  const tableBlocks: string[][] = [];
  let mermaidBlocks = 0;
  let i = 0;
  while (i < lines.length) {
    // Mermaid fenced block — auto-renders to a diagram, not source text, so
    // pull it out of the prose estimate and count it for a flat diagram height.
    if (/^```mermaid\b/.test(lines[i].trim())) {
      mermaidBlocks++;
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        i++;
      }
      if (i < lines.length) {
        i++; // consume the closing fence
      }
      continue;
    }
    // A GFM table is a header row immediately followed by a separator row.
    if (
      isTableRowLine(lines[i]) &&
      i + 1 < lines.length &&
      isTableSeparatorLine(lines[i + 1])
    ) {
      const block = [lines[i], lines[i + 1]];
      i += 2;
      while (i < lines.length && isTableRowLine(lines[i])) {
        block.push(lines[i]);
        i++;
      }
      tableBlocks.push(block);
      continue;
    }
    proseLines.push(lines[i]);
    i++;
  }
  const proseText = proseLines.join("\n");

  // emptyLineWeight: 0.5 — \n\n paragraph breaks render as compact margins
  // (~half a line height), not as full blank lines. Without this, long AI
  // responses with many paragraph breaks are consistently over-estimated by
  // 10-15%, which the bucket correction can't fix (it only scales upward).
  const baseHeight = estimateTextBlockHeight(
    proseText,
    outputContentWidth,
    outputFontSize,
    {
      // 0.47: calibrated from scaleFactor data — 0.42 underestimated (1.12×),
      // 0.56 overestimated (0.78×). Linear interpolation targets scaleFactor=1.0.
      charWidthMultiplier: 0.47,
      lineHeightMultiplier: 1.6,
      verticalChrome: 28,
      emptyLineWeight: 0.5,
    }
  );
  const headingCount = (proseText.match(/^#{1,6}\s+/gm) ?? []).length;
  const bulletCount = (proseText.match(/^\s*(?:[-*+]|\d+\.)\s+/gm) ?? [])
    .length;
  const codeFenceCount = Math.floor(
    (proseText.match(/^```/gm) ?? []).length / 2
  );
  const blockQuoteCount = (proseText.match(/^\s*>\s+/gm) ?? []).length;

  const tableHeight = tableBlocks.reduce(
    (total, block) =>
      total +
      estimateMarkdownTableHeight(block, outputContentWidth, outputFontSize),
    0
  );

  return (
    baseHeight +
    headingCount * 8 +
    bulletCount * 2 +
    codeFenceCount * 14 +
    blockQuoteCount * 6 +
    tableHeight +
    mermaidBlocks * MERMAID_DIAGRAM_ESTIMATED_HEIGHT
  );
}

function estimateCliHeaderHeight(
  row: CliHeaderRow,
  outputContentWidth: number | undefined,
  outputFontSize: number
): number {
  // Include timestamp so flex-wrap behavior matches actual rendering.
  // Use sm font size (FS-1) with body line-height (1.4) to match the header's
  // text-[fp-output-font-size-sm] class and inherited body line-height.
  const timestamp = row.output.timestampMs
    ? `[${new Date(row.output.timestampMs).toLocaleTimeString()}]`
    : "";
  const headerText = [
    timestamp,
    row.stepLabel,
    row.stepName,
    row.output.structured?.metadata?.harness,
    row.output.structured?.metadata?.model,
  ]
    .filter((value): value is string => Boolean(value && value.trim()))
    .join(" ");
  const smFontSize = Math.max(11, outputFontSize - 1);
  const lineCount = Math.max(
    1,
    estimateWrappedLineCount(headerText, outputContentWidth, smFontSize, {
      chrome: HEADER_HORIZONTAL_CHROME,
      charWidthMultiplier: 0.58,
    })
  );
  const lineHeight = Math.max(16, smFontSize * 1.4);
  const actionLines =
    row.promptUndo && (row.promptUndo.undo || row.promptUndo.redo) ? 1 : 0;

  return (
    lineCount * lineHeight +
    actionLines * Math.max(18, outputFontSize * 1.4) +
    HEADER_VERTICAL_CHROME
  );
}

function estimateStatsRowHeight(
  row: StatsRow,
  outputContentWidth: number | undefined,
  outputFontSize: number
): number {
  const parts: string[] = [];
  if (row.output.tokens) {
    const { prompt, completion } = row.output.tokens;
    parts.push(`Tokens: ${prompt} in / ${completion} out`);
  }
  if (row.output.structured?.metadata?.sessionId) {
    parts.push(`Session: ${row.output.structured.metadata.sessionId}`);
  }
  if (!row.output.isStreaming && row.output.elapsed !== undefined) {
    parts.push(`${row.output.elapsed}s`);
  }
  if (!row.output.isStreaming && row.outputText) {
    parts.push("Copy output");
  }
  if (parts.length === 0) {
    return 0;
  }

  const lineCount = estimateWrappedLineCount(
    parts.join(" | "),
    outputContentWidth,
    Math.max(11, outputFontSize - 1),
    {
      chrome: STATS_HORIZONTAL_CHROME,
      charWidthMultiplier: 0.56,
    }
  );
  return (
    Math.max(1, lineCount) * Math.max(16, (outputFontSize - 1) * 1.45) +
    STATS_VERTICAL_CHROME
  );
}

/**
 * Script-output slices render exactly like a raw `plain-response` block, so
 * they must be estimated with the same calibration — the only difference is
 * that the block's vertical chrome belongs to the run as a whole, not to each
 * slice. Splitting it across the first and last slice keeps a multi-row run the
 * same total height as the single row it replaced, so nothing drifts when the
 * user expands or the stream crosses a segment boundary.
 */
function estimateScriptOutputHeight(
  row: ScriptOutputRow,
  outputContentWidth: number | undefined,
  outputFontSize: number
): number {
  const verticalChrome =
    (row.isFirstSegment ? OUTPUT_BLOCK_VERTICAL_CHROME / 2 : 0) +
    (row.isLastSegment ? OUTPUT_BLOCK_VERTICAL_CHROME / 2 : 0);
  const toggleHeight = row.tailToggle ? Math.max(16, outputFontSize * 1.55) : 0;

  return (
    estimateTextBlockHeight(row.text, outputContentWidth, outputFontSize, {
      verticalChrome,
    }) + toggleHeight
  );
}

function estimateCollapsedScriptVerdictHeight(
  row: ScriptVerdictRow,
  outputContentWidth: number | undefined,
  outputFontSize: number
): number {
  const verdict = row.verdict;
  const actualPreview = buildCollapsedOutputPreview(verdict.actual, {
    expanded: false,
    maxLines: DEFAULT_COLLAPSED_OUTPUT_MAX_LINES,
    maxChars: DEFAULT_COLLAPSED_OUTPUT_MAX_CHARS,
  });
  const summaryText = [
    verdict.outcome,
    verdict.compareSource,
    verdict.actualSource,
    verdict.expected == null ? "" : `expected ${verdict.expected}`,
    `actual ${actualPreview.visibleText.replace(/\s+/g, " ") || "∅"}`,
    verdict.actionDetail ?? verdict.action,
    `${(verdict.durationMs / 1000).toFixed(1)}s`,
  ]
    .filter(Boolean)
    .join(" · ");

  return Math.max(
    36,
    estimateTextBlockHeight(
      summaryText,
      outputContentWidth,
      Math.max(11, outputFontSize - 1),
      {
        charWidthMultiplier: 0.56,
        lineHeightMultiplier: 1.45,
        verticalChrome: 8,
        chrome: OUTPUT_ROW_HORIZONTAL_PADDING + 8,
      }
    )
  );
}

/**
 * Height of a ● header line (or a short one-line block that renders like one).
 * Uses the ● block's real geometry: `leading-relaxed` at the base font size
 * over `my-2`, with only the row's own `px-[var(--spacing-md)]` taken out
 * horizontally — ToolCallBlock adds no padding of its own.
 */
function estimateTerminalSummaryHeight(
  text: string,
  outputContentWidth: number | undefined,
  outputFontSize: number,
  verticalChrome = TOOL_CALL_BLOCK_VERTICAL_CHROME
): number {
  const lineCount = estimateWrappedLineCount(
    text,
    outputContentWidth,
    outputFontSize,
    {
      chrome: OUTPUT_ROW_HORIZONTAL_PADDING,
      charWidthMultiplier: 0.6,
    }
  );
  return (
    Math.max(1, lineCount) * toolCallLineHeight(outputFontSize) + verticalChrome
  );
}

function estimateFileOperationHeaderHeight(
  actionLabel: string,
  path: string,
  outputContentWidth: number | undefined,
  outputFontSize: number,
  error?: string
): number {
  return (
    estimateFileOperationHeaderLines(
      actionLabel,
      path,
      outputContentWidth,
      outputFontSize
    ) *
      toolCallLineHeight(outputFontSize) +
    (error
      ? Math.max(
          1,
          estimateWrappedLineCount(error, outputContentWidth, outputFontSize, {
            chrome: OUTPUT_ROW_HORIZONTAL_PADDING,
            charWidthMultiplier: 0.6,
          })
        ) * toolResultLineHeight(outputFontSize)
      : 0) +
    TOOL_CALL_BLOCK_VERTICAL_CHROME
  );
}

function estimateBashOutputHeight(
  event: CliEvent,
  outputContentWidth: number | undefined,
  outputFontSize: number,
  expansion?: OutputRowBashExpansionState,
  maxResultLines = DEFAULT_COLLAPSED_OUTPUT_MAX_LINES,
  maxResultCharacters = BASH_RESULT_MAX_CHARS
): number {
  const data = event.data as {
    command?: string;
    output?: string;
    error?: string;
    status?: string;
  };
  // TOOL_CALL_LINE has no whitespace-pre-wrap, so \n in the command string
  // collapses to a space in rendering. Flatten before estimating to avoid
  // counting each embedded newline as a separate visual line.
  const commandText = (
    sanitizeTerminalOutput(data.command ?? "").trim() || "command unavailable"
  ).replace(/\n/g, " ");
  const commandPreview = buildCollapsedSingleLinePreview(commandText, {
    expanded: expansion?.commandExpanded ?? false,
    maxChars: DEFAULT_COLLAPSED_COMMAND_MAX_CHARS,
  });
  // TOOL_CALL_TERMINAL has my-2=16px total vertical margin (captured via
  // flow-root). Split as 8px for command + 8px for result = 16px total.
  let totalHeight = estimateTerminalSummaryHeight(
    commandPreview.visibleText,
    outputContentWidth,
    outputFontSize,
    TOOL_CALL_BLOCK_HALF_VERTICAL_CHROME
  );

  const isCompleted =
    data.status === undefined ||
    data.status === OPERATION_STATUS.COMPLETED ||
    data.status === OPERATION_STATUS.FAILED;
  if (!isCompleted) {
    return totalHeight + TOOL_CALL_BLOCK_HALF_VERTICAL_CHROME;
  }

  // Match BashOutput.tsx duplicate detection: when output and error are
  // identical after stripping whitespace, only the error section renders.
  const normalizedOutput = normalizeTextForLayout(
    sanitizeTerminalOutput(data.output ?? "")
  );
  const normalizedError = normalizeTextForLayout(
    sanitizeTerminalOutput(data.error ?? "")
  );
  const isDuplicate =
    normalizedOutput.trim().length > 0 &&
    normalizedOutput.trim() === normalizedError.trim();
  const contentsToEstimate = isDuplicate
    ? [
        {
          content: normalizedError,
          expanded: expansion?.errorExpanded ?? false,
        },
      ]
    : [
        {
          content: normalizedOutput,
          expanded: expansion?.outputExpanded ?? false,
        },
        {
          content: normalizedError,
          expanded: expansion?.errorExpanded ?? false,
        },
      ];

  for (const { content, expanded } of contentsToEstimate) {
    // Skip empty/whitespace-only content — BashOutput sanitizes ANSI codes
    // which often leaves blank-only error streams that don't render.
    if (!content || content.trim().length === 0) continue;
    const preview = buildCollapsedOutputPreview(content, {
      expanded,
      maxLines: maxResultLines,
      maxChars: maxResultCharacters,
    });
    // The "[show N more lines]" toggle is an inline <button> appended to the
    // last visible line, not a block of its own — it only costs a line when it
    // happens to wrap. Charging it a full line unconditionally was the single
    // largest bias on this row kind.
    totalHeight +=
      estimateWrappedLineCount(
        preview.visibleText,
        outputContentWidth,
        outputFontSize - 1,
        {
          chrome:
            OUTPUT_ROW_HORIZONTAL_PADDING +
            toolResultPrefixWidth(outputFontSize),
          charWidthMultiplier: 0.6,
        }
      ) * toolResultLineHeight(outputFontSize);
  }

  return totalHeight + TOOL_CALL_BLOCK_HALF_VERTICAL_CHROME;
}

/**
 * AskUserQuestion has no measured DOM geometry to calibrate against yet (it's
 * a new row kind), so this follows the same shape as the other ● block
 * estimators — header line + a wrapped-line estimate per rendered text piece —
 * and relies on the virtualizer's post-measurement correction for the rest.
 */
function estimateAskUserQuestionHeight(
  data: AskUserQuestionData,
  outputContentWidth: number | undefined,
  outputFontSize: number
): number {
  const smFontSize = Math.max(11, outputFontSize - 1);
  const detailChrome = OUTPUT_ROW_HORIZONTAL_PADDING + 12;
  const detailLine = (text: string) =>
    Math.max(
      1,
      estimateWrappedLineCount(text, outputContentWidth, smFontSize, {
        chrome: detailChrome,
        charWidthMultiplier: 0.58,
      })
    ) * toolResultLineHeight(outputFontSize);

  let height =
    TOOL_CALL_BLOCK_VERTICAL_CHROME + toolCallLineHeight(outputFontSize);

  for (const question of data.questions) {
    height +=
      Math.max(
        1,
        estimateWrappedLineCount(
          question.question,
          outputContentWidth,
          outputFontSize,
          { chrome: OUTPUT_ROW_HORIZONTAL_PADDING, charWidthMultiplier: 0.6 }
        )
      ) * toolCallLineHeight(outputFontSize);

    for (const option of question.options) {
      height += detailLine(
        option.description
          ? `${option.label}: ${option.description}`
          : option.label
      );
      if (option.label === question.answer && option.preview) {
        height +=
          option.preview.split("\n").length *
          toolResultLineHeight(outputFontSize);
      }
    }

    const answerIsCustomReply =
      question.answer &&
      !question.options.some((option) => option.label === question.answer);
    if (answerIsCustomReply) {
      height += detailLine(question.answer!);
    }
    if (question.notes) {
      height += detailLine(question.notes);
    }

    height += 6;
  }

  if (data.declined) {
    height += toolResultLineHeight(outputFontSize);
    if (data.declined.feedback) {
      height += detailLine(data.declined.feedback);
    }
  }

  return height;
}

function estimateStructuredTextHeight(
  row: StructuredEventRow,
  fullContentWidth: number | undefined,
  outputFontSize: number
): number {
  // ● blocks render inside ToolCallBlock, whose gutter column narrows every
  // line — header text and body alike. Non-block events (text, thinking, the
  // compaction/follow-up dividers, a bare tool result) keep the full width.
  const gutter = toolCallGutterWidth(outputFontSize);
  const outputContentWidth =
    fullContentWidth != null ? fullContentWidth - gutter : undefined;

  switch (row.event.type) {
    case CLI_EVENT_TYPES.TEXT: {
      const text = (row.event.data as { text?: string }).text ?? "";
      return row.rawTextOutput
        ? estimateTextBlockHeight(text, fullContentWidth, outputFontSize)
        : estimateMarkdownBlockHeight(text, fullContentWidth, outputFontSize);
    }
    case CLI_EVENT_TYPES.THINKING: {
      const text = (row.event.data as { text?: string }).text ?? "";
      const contentHeight = estimateTextBlockHeight(
        text,
        fullContentWidth,
        outputFontSize,
        {
          chrome: OUTPUT_ROW_HORIZONTAL_CHROME,
          charWidthMultiplier: 0.56,
          lineHeightMultiplier: 1.6,
          verticalChrome: THINKING_CONTENT_VERTICAL_CHROME,
        }
      );
      return (
        THINKING_LABEL_HEIGHT + contentHeight + THINKING_OUTER_VERTICAL_CHROME
      );
    }
    case CLI_EVENT_TYPES.BASH_COMMAND:
      return estimateBashOutputHeight(
        row.event,
        outputContentWidth,
        outputFontSize,
        row.bashExpansion,
        row.collapsedToolOutputLineCount,
        row.collapsedToolOutputMaxCharacters
      );
    case CLI_EVENT_TYPES.FILE_EDIT: {
      const data = row.event.data as { path?: string; error?: string };
      return estimateFileOperationHeaderHeight(
        "Edited",
        data.path ?? "file",
        outputContentWidth,
        outputFontSize,
        data.error
      );
    }
    case CLI_EVENT_TYPES.FILE_WRITE: {
      const data = row.event.data as {
        path?: string;
        content?: string;
        error?: string;
      };
      const sizeInfo = data.content ? ` (${data.content.length} bytes)` : "";
      return estimateFileOperationHeaderHeight(
        `Wrote${sizeInfo}`,
        data.path ?? "file",
        outputContentWidth,
        outputFontSize,
        data.error
      );
    }
    case CLI_EVENT_TYPES.FILE_READ: {
      const data = row.event.data as { path?: string; error?: string };
      return estimateFileOperationHeaderHeight(
        "Read",
        data.path ?? "file",
        outputContentWidth,
        outputFontSize,
        data.error
      );
    }
    case CLI_EVENT_TYPES.FILE_DELETE: {
      const data = row.event.data as { path?: string; error?: string };
      return estimateFileOperationHeaderHeight(
        "Delete file:",
        data.path ?? "file",
        outputContentWidth,
        outputFontSize,
        data.error
      );
    }
    case CLI_EVENT_TYPES.WEB_SEARCH: {
      const data = row.event.data as { query?: string; error?: string };
      return estimateTerminalSummaryHeight(
        `Web search ${data.query ?? ""} ${data.error ?? ""}`.trim(),
        outputContentWidth,
        outputFontSize
      );
    }
    case CLI_EVENT_TYPES.TOOL_RESULT: {
      const data = row.event.data as {
        result?: { success: boolean; output?: string; error?: string };
      };
      const content =
        (!data.result?.success && data.result?.error) ||
        data.result?.output ||
        (data.result?.success ? "Success" : "Failed") ||
        "";
      return estimateTextBlockHeight(
        content.slice(0, 200),
        fullContentWidth,
        outputFontSize,
        {
          charWidthMultiplier: 0.6,
          lineHeightMultiplier: 1.55,
          verticalChrome: 14,
        }
      );
    }
    case CLI_EVENT_TYPES.COMPACTION: {
      const data = row.event.data as {
        trigger?: string;
        preTokens?: number;
        postTokens?: number;
      };
      const label = `Conversation compacted (${data.trigger ?? "unknown"}) ${
        data.preTokens != null && data.postTokens != null
          ? `${data.preTokens} -> ${data.postTokens} tokens`
          : ""
      }`.trim();
      return estimateTerminalSummaryHeight(
        label,
        fullContentWidth,
        outputFontSize,
        18
      );
    }
    case CLI_EVENT_TYPES.FOLLOW_UP_RESUMED: {
      return estimateTerminalSummaryHeight(
        "Follow-up",
        fullContentWidth,
        outputFontSize,
        18
      );
    }
    case CLI_EVENT_TYPES.ASK_USER_QUESTION: {
      const data = row.event.data as AskUserQuestionData;
      return estimateAskUserQuestionHeight(
        data,
        outputContentWidth,
        outputFontSize
      );
    }
    default:
      return 64;
  }
}

function estimateBaseStructuredEventHeight(
  row: StructuredEventRow,
  outputContentWidth: number | undefined,
  outputFontSize: number
): number {
  if (
    (row.event.type === CLI_EVENT_TYPES.TOOL_CALL ||
      row.event.type === CLI_EVENT_TYPES.MCP_TOOL_CALL) &&
    row.toolCall
  ) {
    return estimateToolCallStructuredEventHeight(
      row,
      outputFontSize,
      outputContentWidth
    );
  }

  if (row.diff && !row.hideDiff) {
    return row.diff.renderPlan.totalHeight;
  }

  return estimateStructuredTextHeight(row, outputContentWidth, outputFontSize);
}

function estimateDiffStructuredEventHeight(
  row: StructuredEventRow,
  outputContentWidth: number | undefined,
  outputFontSize: number
): number {
  if (!row.diff || row.hideDiff) {
    return estimateBaseStructuredEventHeight(
      row,
      outputContentWidth,
      outputFontSize
    );
  }
  return row.diff.renderPlan.totalHeight;
}

function estimateToolCallStructuredEventHeight(
  row: StructuredEventRow,
  outputFontSize: number,
  outputContentWidth?: number
): number {
  if (
    (row.event.type !== CLI_EVENT_TYPES.TOOL_CALL &&
      row.event.type !== CLI_EVENT_TYPES.MCP_TOOL_CALL) ||
    !row.toolCall
  ) {
    return 64;
  }

  // When content width is known, recompute with wrapping-aware estimation —
  // renderPlan.totalHeight was built without content width and underestimates
  // heavily for tool calls with long output lines (whitespace-pre-wrap).
  if (row.toolCall.renderPlan && outputContentWidth == null) {
    return row.toolCall.renderPlan.totalHeight;
  }

  const data = row.event.data as ToolCall | McpToolCallData;
  return estimateGenericToolCallHeight(
    data.parameters,
    data.result,
    row.toolCall.expansion,
    outputFontSize,
    outputContentWidth == null
      ? undefined
      : outputContentWidth - toolCallGutterWidth(outputFontSize),
    row.collapsedToolOutputLineCount
  );
}

interface RowHeightEstimateCacheEntry {
  contentWidth: number | undefined;
  fontSize: number;
  height: number;
}

/**
 * Memo for `estimateOutputRowHeight`, keyed on the row object.
 *
 * The virtualizer rebuilds its entire measurements array every time a single
 * row reports a size, calling `estimateSize` for every row from the lowest
 * changed index to the end of the list — so on a 6,000-row workflow one
 * measured row costs thousands of estimates, several times per commit. Those
 * estimates are not cheap: a Bash row re-sanitizes its event's whole output
 * (tens of KB is normal) to size a preview of a few hundred characters. Profiled
 * cold, a single pass over 4,800 rows costs ~190ms on a desktop, which is what
 * put 600-2500ms React commits in the phone logs for panes holding only 3-13
 * mounted rows.
 *
 * Keying on the row object rather than `row.key` is what makes a stale hit
 * impossible: `buildOutputRows` constructs rows fresh and never mutates one, so
 * a row whose content or expansion state changed is necessarily a different
 * object. Geometry is the only estimate input that lives outside the row, so it
 * is stored alongside and revalidated — compared field-wise rather than through
 * a composite key so a full pass allocates nothing.
 */
const rowHeightEstimateCache = new WeakMap<
  OutputRenderRow,
  RowHeightEstimateCacheEntry
>();

export function estimateOutputRowHeight(
  row: OutputRenderRow,
  outputFontSize = 13,
  outputContentWidth?: number
): number {
  const cached = rowHeightEstimateCache.get(row);
  if (
    cached !== undefined &&
    cached.fontSize === outputFontSize &&
    cached.contentWidth === outputContentWidth
  ) {
    return cached.height;
  }

  // Rows at a CLI group's edges get extra padding from OutputRow's wrapper, and
  // a row that opens an activity slice gets ActivityAttribution's label above
  // it. Only rows that carry the flags are wrapped, so both are safe to add
  // unconditionally — and the group padding is the whole story behind the
  // persistent bias on `stats` (always a group's last row) and `cli-header`
  // (always its first).
  const height =
    estimateOutputRowContentHeight(row, outputFontSize, outputContentWidth) +
    outputRowGroupPadding(row) +
    outputRowActivityChrome(row);
  rowHeightEstimateCache.set(row, {
    contentWidth: outputContentWidth,
    fontSize: outputFontSize,
    height,
  });
  return height;
}

function estimateOutputRowContentHeight(
  row: OutputRenderRow,
  outputFontSize: number,
  outputContentWidth?: number
): number {
  switch (row.rowKind) {
    case OUTPUT_ROW_KINDS.STEP_ANCHOR:
      return 1;
    case OUTPUT_ROW_KINDS.STEP_HIDDEN:
      return STEP_HIDDEN_ROW_HEIGHT;
    case OUTPUT_ROW_KINDS.FINAL_STEP_LABEL:
      return 24;
    case OUTPUT_ROW_KINDS.STATUS:
      return estimateTextBlockHeight(
        row.status.message,
        outputContentWidth,
        outputFontSize,
        {
          charWidthMultiplier: 0.56,
          lineHeightMultiplier: 1.45,
          verticalChrome: STATUS_ROW_VERTICAL_CHROME,
        }
      );
    case OUTPUT_ROW_KINDS.CLI_HEADER:
      return estimateCliHeaderHeight(row, outputContentWidth, outputFontSize);
    case OUTPUT_ROW_KINDS.PROMPT:
      // OUTPUT_BLOCK_BASE: font-mono sm font, body line-height:1.4, py-sm+my-sm=24px chrome.
      // chrome:32 matches actual horizontal padding (px-md outer + px-sm inner + border-l-3).
      return estimateTextBlockHeight(
        row.text,
        outputContentWidth,
        outputFontSize - 1,
        {
          charWidthMultiplier: 0.6,
          lineHeightMultiplier: 1.4,
          verticalChrome: 24,
          chrome: 32,
          wrapAtWords: true,
        }
      );
    case OUTPUT_ROW_KINDS.CLI_COMMAND:
    case OUTPUT_ROW_KINDS.SCRIPT_COMMAND:
      // OUTPUT_BLOCK_BASE: font-mono sm font, body line-height:1.4, py-sm+my-sm=24px chrome.
      // chrome:32 matches actual horizontal padding (px-md outer + px-sm inner + border-l-3).
      return estimateCliCommandRowHeight(
        row,
        outputContentWidth,
        outputFontSize
      );
    case OUTPUT_ROW_KINDS.ERROR:
      return estimateTextBlockHeight(
        `${row.timestamp ? `[${row.timestamp}] ` : ""}Error: ${row.errorMessage}`,
        outputContentWidth,
        outputFontSize,
        {
          charWidthMultiplier: 0.58,
          lineHeightMultiplier: 1.5,
          verticalChrome: 22,
        }
      );
    case OUTPUT_ROW_KINDS.PLAIN_RESPONSE:
      return row.rawTextOutput
        ? estimateTextBlockHeight(row.text, outputContentWidth, outputFontSize)
        : estimateMarkdownBlockHeight(
            row.text,
            outputContentWidth,
            outputFontSize
          );
    case OUTPUT_ROW_KINDS.SCRIPT_OUTPUT:
      return estimateScriptOutputHeight(
        row,
        outputContentWidth,
        outputFontSize
      );
    case OUTPUT_ROW_KINDS.SCRIPT_VERDICT:
      return row.expanded
        ? 220
        : estimateCollapsedScriptVerdictHeight(
            row,
            outputContentWidth,
            outputFontSize
          );
    case OUTPUT_ROW_KINDS.ATTEMPT_GROUP_SUMMARY:
      return 36;
    case OUTPUT_ROW_KINDS.STATS:
      return estimateStatsRowHeight(row, outputContentWidth, outputFontSize);
    case OUTPUT_ROW_KINDS.STRUCTURED_EVENT:
      return row.diff
        ? estimateDiffStructuredEventHeight(
            row,
            outputContentWidth,
            outputFontSize
          )
        : estimateBaseStructuredEventHeight(
            row,
            outputContentWidth,
            outputFontSize
          );
  }
}

function estimateCliCommandRowHeight(
  row: CliCommandRow | ScriptCommandRow,
  outputContentWidth: number | undefined,
  outputFontSize: number
): number {
  return estimateTextBlockHeight(
    formatCliCommandDisplay(row.command, row.workingDirectory, row.wasInjected),
    outputContentWidth,
    outputFontSize - 1,
    {
      charWidthMultiplier: 0.6,
      lineHeightMultiplier: 1.4,
      verticalChrome: 24,
      chrome: 32,
      wrapAtWords: true,
    }
  );
}

export function estimateOutputDiffBlockHeight(
  row: StructuredEventRow,
  _outputFontSize = 13
): number {
  if (!row.diff || row.hideDiff) {
    return row.estimateSize;
  }
  return row.diff.renderPlan.diffBlockHeight;
}

interface ScriptOutputRowsRequest {
  rows: OutputRenderRow[];
  /** Row keys are derived from this; must be unique per attempt and phase. */
  baseKey: string;
  target: OutputMessageTarget;
  text: string;
  /**
   * True while the script is still producing output. The trailing window is
   * what the user is actually watching, and withholding the rest keeps the cost
   * of an append proportional to the window instead of to everything printed so
   * far. Completed output is emitted whole — it has stopped changing, and the
   * slices make it cheap to render.
   */
  capToTail: boolean;
  expansionState?: ReadonlyMap<string, boolean>;
}

/**
 * Emits a script's output as bounded slices, optionally capped to its tail.
 *
 * Collapsed and expanded slices deliberately use disjoint key prefixes: a key
 * that survived the toggle would keep the measured height of whatever it used
 * to hold, and the two states put very different text at the same index.
 */
function pushScriptOutputRows({
  rows,
  baseKey,
  target,
  text,
  capToTail,
  expansionState,
}: ScriptOutputRowsRequest): void {
  // Treat row construction as the final UI boundary. Live dashboard messages
  // are sanitized before delivery, but sanitizing the accumulated text here
  // also covers restored/legacy data and escape sequences split across chunks.
  const sanitizedText = sanitizeTerminalOutput(text);
  const toggleKey = `${baseKey}:tail-toggle`;
  const expanded = expansionState?.get(toggleKey) ?? false;
  const tailWindow =
    capToTail && !expanded
      ? takeTrailingLines(sanitizedText, SCRIPT_OUTPUT_LINES_PER_ROW)
      : null;
  const segments = splitTextIntoLineSegments(
    tailWindow ? tailWindow.text : sanitizedText,
    SCRIPT_OUTPUT_LINES_PER_ROW
  );
  if (segments.length === 0) {
    return;
  }

  const hiddenLineCount = tailWindow?.hiddenLineCount ?? 0;
  // The toggle earns its line only when it has something to reveal or undo.
  const showTailToggle = capToTail && (hiddenLineCount > 0 || expanded);

  for (const [index, segment] of segments.entries()) {
    const isLastSegment = index === segments.length - 1;
    rows.push({
      key: tailWindow ? `${baseKey}:tail` : `${baseKey}:segment${index}`,
      rowKind: OUTPUT_ROW_KINDS.SCRIPT_OUTPUT,
      target,
      text: segment,
      isFirstSegment: index === 0,
      isLastSegment,
      tailToggle:
        showTailToggle && isLastSegment
          ? { key: toggleKey, hiddenLineCount, expanded }
          : undefined,
      estimateSize: 120,
    });
  }
}

export function buildOutputRows(
  input: BuildOutputRowsInput
): BuildOutputRowsResult {
  const rows: OutputRenderRow[] = [];
  const stepOutputsMap = new Map<string, CliOutputType[]>();
  const lastCliIndexPerStep = new Map<string, number>();
  const lastAttemptRowKeyBasePerStep = new Map<string, string>();
  const uniqueTargets = new Map<string, OutputMessageTarget>();
  const stepColorByTargetKey = new Map<string, string | undefined>();
  const firstRowIndexByTarget = new Map<string, number>();
  const anchorRowIndexByTarget = new Map<string, number>();
  const collapsedToolOutputLineCount =
    input.collapsedToolOutputLineCount ?? DEFAULT_COLLAPSED_OUTPUT_MAX_LINES;
  // OutputSection starts with an unmeasured width of 0. Treat that as unknown,
  // just like undefined, so the discoverable label is present on first paint.
  const showParamsLabel =
    input.outputContentWidth == null ||
    input.outputContentWidth === 0 ||
    input.outputContentWidth >= OUTPUT_SECTION_HEADER_NARROW_THRESHOLD;
  const attemptGroups = new Map<string, AttemptGroupAggregate>();
  const attemptGroupByMessageIndex = new Map<number, string>();
  const activityTargets = new Set(
    input.allMessages
      .filter(
        (message) =>
          message.isActivity &&
          message.activityKind !== OUTPUT_ACTIVITY_KINDS.STATUS
      )
      .map((message) => getTargetKey(message.target))
  );
  const activityStatusTargets = new Set(
    input.allMessages
      .filter(
        (message) =>
          message.isActivity &&
          message.activityKind === OUTPUT_ACTIVITY_KINDS.STATUS
      )
      .map((message) => getTargetKey(message.target))
  );
  const getStepOutputColor = (
    target: OutputMessageTarget
  ): string | undefined => {
    const targetKey = getTargetKey(target);
    const cached = stepColorByTargetKey.get(targetKey);
    if (cached !== undefined) return cached;

    const step =
      target.kind === FINAL_STEP_PHASES.FINAL_STEP
        ? input.finalStep
        : input.steps[target.index];
    if (!step) return undefined;

    const group =
      target.kind === FINAL_STEP_PHASES.QUEUE
        ? getParallelGroupForStep(input.parallelGroups, target.index)
        : undefined;
    const groupMembers =
      input.stepColorMode === STEP_COLOR_MODES.HARNESS && group
        ? input.steps
            .slice(group.startIndex, group.endIndex + 1)
            .map((member, offsetInGroup) => ({
              step: member,
              harnessId: getEffectiveStepHarness(
                member,
                input.effectiveHarness
              ),
              offsetInGroup,
            }))
        : undefined;
    const color = resolveStepColor({
      step,
      harnessId: getEffectiveStepHarness(step, input.effectiveHarness),
      stepIndex:
        target.kind === FINAL_STEP_PHASES.FINAL_STEP
          ? input.steps.length
          : target.index,
      stepColorMode: input.stepColorMode,
      settings: input.harnessColorSettings,
      group,
      offsetInGroup:
        group === undefined ? undefined : target.index - group.startIndex,
      groupMembers,
    });
    stepColorByTargetKey.set(targetKey, color);
    return color;
  };
  let previousActivityTargetKey: string | undefined;
  // An attempt's chrome belongs to the attempt, not to each activity slice
  // inside it: the header/prompt/command/error open the block and the
  // verdict/stats close it. Emitting them per slice repeated a full CLI header
  // and token footer around every interleaved fragment. Leading chrome goes on
  // the attempt's first slice, trailing chrome on its last.
  const lastActivityMessageIndexByAttempt = new Map<string, number>();
  for (const [messageIndex, message] of input.allMessages.entries()) {
    if (!message.isActivity || message.type !== OUTPUT_MESSAGE_TYPES.CLI) {
      continue;
    }
    const output = (message.aggregate ?? message.data) as CliOutputType;
    lastActivityMessageIndexByAttempt.set(
      getAttemptRowKeyBase(
        getTargetKey(message.target),
        message.runIndex ?? output.runIndex ?? 0,
        message.attemptIndex ?? 0
      ),
      messageIndex
    );
  }
  const attemptsWithLeadingChrome = new Set<string>();

  for (const [messageIndex, message] of input.allMessages.entries()) {
    if (message.isActivity) continue;
    const groupKey = getAttemptGroupKey(message);
    if (!groupKey || message.type !== OUTPUT_MESSAGE_TYPES.CLI) continue;
    const output = message.data as CliOutputType;
    const runIndex = message.runIndex ?? output.runIndex ?? 0;
    const attemptKey = `${runIndex}:${message.attemptIndex ?? 0}`;
    const group =
      attemptGroups.get(groupKey) ??
      ({
        key: groupKey,
        target: message.target,
        firstMessageIndex: messageIndex,
        attempts: new Map<string, CliOutputType>(),
      } satisfies AttemptGroupAggregate);
    group.attempts.set(attemptKey, output);
    group.firstMessageIndex = Math.min(group.firstMessageIndex, messageIndex);
    attemptGroups.set(groupKey, group);
    attemptGroupByMessageIndex.set(messageIndex, groupKey);
  }

  for (const [messageIndex, message] of input.allMessages.entries()) {
    const targetKey = getTargetKey(message.target);
    if (!uniqueTargets.has(targetKey)) {
      uniqueTargets.set(targetKey, message.target);
    }

    if (message.type === OUTPUT_MESSAGE_TYPES.CLI) {
      const stepOutputs = stepOutputsMap.get(targetKey) ?? [];
      stepOutputs.push((message.aggregate ?? message.data) as CliOutputType);
      stepOutputsMap.set(targetKey, stepOutputs);
      lastCliIndexPerStep.set(targetKey, messageIndex);
      // Keyed by attempt (not raw message index) so a multi-activity attempt's
      // *header* — emitted at the attempt's first message, not its last — can
      // still recognize itself as the step's latest attempt below.
      const cliOutput = (message.aggregate ?? message.data) as CliOutputType;
      const runIndex = message.runIndex ?? cliOutput.runIndex ?? 0;
      const attemptIndex = message.attemptIndex ?? 0;
      lastAttemptRowKeyBasePerStep.set(
        targetKey,
        getAttemptRowKeyBase(targetKey, runIndex, attemptIndex)
      );
    }
  }

  for (const [messageIndex, message] of input.allMessages.entries()) {
    const target = message.target;
    const targetKey = getTargetKey(target);
    const isFirstForTarget = !firstRowIndexByTarget.has(targetKey);
    if (isFirstForTarget) {
      firstRowIndexByTarget.set(targetKey, rows.length);
      anchorRowIndexByTarget.set(targetKey, rows.length);
      rows.push({
        key: `${targetKey}:anchor`,
        rowKind: OUTPUT_ROW_KINDS.STEP_ANCHOR,
        target,
        estimateSize: 1,
      });
      if (input.hiddenTargetKeys?.has(targetKey)) {
        const isFinalStep = target.kind === FINAL_STEP_PHASES.FINAL_STEP;
        const workflowStep = isFinalStep
          ? input.finalStep
          : input.steps[target.index];
        rows.push({
          key: `${targetKey}:hidden`,
          rowKind: OUTPUT_ROW_KINDS.STEP_HIDDEN,
          target,
          stepLabel: isFinalStep
            ? `Final Step Loop ${target.index + 1}`
            : `Step ${target.index + 1}`,
          stepName: isFinalStep
            ? getStepName(workflowStep, `Final Step Loop ${target.index + 1}`)
            : workflowStep?.name?.trim() || undefined,
          estimateSize: STEP_HIDDEN_ROW_HEIGHT,
        });
        continue;
      }
      if (target.kind === FINAL_STEP_PHASES.FINAL_STEP) {
        rows.push({
          key: `${targetKey}:final-step-label`,
          rowKind: OUTPUT_ROW_KINDS.FINAL_STEP_LABEL,
          target,
          label: `Final Step Loop ${target.index + 1}`,
          estimateSize: 24,
        });
      }
    }

    if (input.hiddenTargetKeys?.has(targetKey)) continue;

    if (message.type === OUTPUT_MESSAGE_TYPES.STATUS) {
      if (!message.isActivity && activityStatusTargets.has(targetKey)) continue;
      const activityFirst =
        message.isActivity && previousActivityTargetKey !== targetKey;
      const stampActivityFirst =
        activityFirst &&
        getParallelGroupForStep(input.parallelGroups, target.index) !==
          undefined;
      if (message.isActivity) previousActivityTargetKey = targetKey;
      rows.push({
        key: `${targetKey}:status:${messageIndex}`,
        rowKind: OUTPUT_ROW_KINDS.STATUS,
        target,
        status: message.data as OutputStatusMessage,
        activityKey: message.activityKey,
        activityFirst:
          message.isActivity && stampActivityFirst ? true : undefined,
        activityLabel: message.isActivity
          ? stampActivityFirst
            ? `Step ${target.index + 1}`
            : undefined
          : undefined,
        estimateSize: 36,
      });
      continue;
    }

    if (!message.isActivity && activityTargets.has(targetKey)) {
      continue;
    }

    const attemptGroupKey = attemptGroupByMessageIndex.get(messageIndex);
    const attemptGroup = attemptGroupKey
      ? attemptGroups.get(attemptGroupKey)
      : undefined;
    if (
      attemptGroup &&
      input.collapsedAttemptGroupKeys?.has(attemptGroup.key)
    ) {
      if (messageIndex !== attemptGroup.firstMessageIndex) continue;

      let total = 0;
      let hasUsableTotal = false;
      let hasMissingTotal = false;
      for (const output of attemptGroup.attempts.values()) {
        const attemptTotal = resolveTokenTotal(
          output.tokens?.total,
          output.tokens?.prompt,
          output.tokens?.completion
        );
        if (attemptTotal === undefined) {
          hasMissingTotal = true;
        } else {
          total += attemptTotal;
          hasUsableTotal = true;
        }
      }

      rows.push({
        key: `${attemptGroup.key}:summary`,
        rowKind: OUTPUT_ROW_KINDS.ATTEMPT_GROUP_SUMMARY,
        target: attemptGroup.target,
        groupKey: attemptGroup.key,
        attemptCount: attemptGroup.attempts.size,
        total: hasUsableTotal ? total : undefined,
        coverage: hasMissingTotal
          ? WORKFLOW_TOKEN_COVERAGE.PARTIAL
          : WORKFLOW_TOKEN_COVERAGE.COMPLETE,
        groupStart: true,
        groupEnd: true,
        estimateSize: 36,
      });
      continue;
    }

    const aggregateOutput = (message.aggregate ??
      message.data) as CliOutputType;
    let output = aggregateOutput;
    const groupStartIndex = rows.length;
    const isFinalStep = target.kind === FINAL_STEP_PHASES.FINAL_STEP;
    const workflowStep = isFinalStep
      ? input.finalStep
      : input.steps[target.index];
    const stepName = isFinalStep
      ? getStepName(workflowStep, `Final Step Loop ${target.index + 1}`)
      : workflowStep?.name?.trim() || undefined;
    const stepLabel = isFinalStep
      ? `Final Step Loop ${target.index + 1}`
      : `Step ${target.index + 1}`;
    const attemptIndex = message.attemptIndex ?? 0;
    const runIndex = message.runIndex ?? output.runIndex ?? 0;
    const attemptRowKeyBase = getAttemptRowKeyBase(
      targetKey,
      runIndex,
      attemptIndex
    );
    const rowKeyBase = getRowKeyBase(attemptRowKeyBase, message);
    const emitsLeadingChrome =
      !message.isActivity || !attemptsWithLeadingChrome.has(attemptRowKeyBase);
    const emitsTrailingChrome =
      !message.isActivity ||
      lastActivityMessageIndexByAttempt.get(attemptRowKeyBase) === messageIndex;
    if (message.isActivity) attemptsWithLeadingChrome.add(attemptRowKeyBase);
    const outputText = getCliTextForCopy(output);
    const { workspaceSnapshot, undoRecord } = getStepOutputArtifacts(
      input,
      target
    );
    const allStepOutputs = stepOutputsMap.get(targetKey) ?? [];
    // Whether *this attempt* (not this message) is the step's latest attempt.
    // A multi-activity attempt spans several messages, and the header row is
    // built from the first of them — comparing raw message indices against
    // the step's overall last message would almost always fail, since that
    // last message usually belongs to a later activity slice of this same
    // attempt (see lastAttemptRowKeyBasePerStep above).
    const isLastAttemptForStep =
      lastAttemptRowKeyBasePerStep.get(targetKey) === attemptRowKeyBase;
    const promptUndoActions =
      input.allowUndoActions && isLastAttemptForStep && !output.isStreaming
        ? (() => {
            const concurrentGroup = getConcurrentGroupForStep(
              input,
              target.index
            );
            if (
              concurrentGroup &&
              target.index !== concurrentGroup.startIndex
            ) {
              return { undo: null, redo: null };
            }
            const effectiveSnapshot = concurrentGroup
              ? input.isViewingHistory && input.historyOutputs
                ? input.historyOutputs.promptOutputs[concurrentGroup.startIndex]
                    ?.workspaceSnapshot
                : input.workspaceSnapshots[concurrentGroup.startIndex]
              : workspaceSnapshot;
            const actions = computePromptUndoActions(
              allStepOutputs,
              undoRecord,
              effectiveSnapshot
            );
            if (!concurrentGroup) return actions;
            return {
              undo: actions.undo
                ? {
                    ...actions.undo,
                    label: `Undo parallel steps ${concurrentGroup.startIndex + 1}–${concurrentGroup.endIndex + 1}`,
                  }
                : null,
              redo: actions.redo
                ? {
                    ...actions.redo,
                    label: `Redo parallel steps ${concurrentGroup.startIndex + 1}–${concurrentGroup.endIndex + 1}`,
                  }
                : null,
            };
          })()
        : { undo: null, redo: null };
    const promptUndo =
      promptUndoActions.undo || promptUndoActions.redo
        ? {
            workspacePath: output.workingDirectory ?? "",
            workspaceSnapshot,
            undoRecord,
            allStepOutputs,
            undo: promptUndoActions.undo,
            redo: promptUndoActions.redo,
          }
        : undefined;

    if (emitsLeadingChrome) {
      rows.push({
        key: `${attemptRowKeyBase}:header`,
        rowKind: OUTPUT_ROW_KINDS.CLI_HEADER,
        target,
        output: aggregateOutput,
        stepIndex: target.index,
        isFinalStep,
        stepLabel,
        stepName,
        attemptIndex,
        runIndex,
        promptUndo,
        estimateSize: 44,
      });
    }

    const scriptish = isScriptOutput(output);
    const activityFirst =
      message.isActivity && previousActivityTargetKey !== targetKey;
    const stampActivityFirst =
      activityFirst &&
      getParallelGroupForStep(input.parallelGroups, target.index) !== undefined;
    if (message.isActivity) previousActivityTargetKey = targetKey;
    // What belongs to *every* row the slice emits. `activityKey` is looked up
    // per row by the minimap and the streaming anchor.
    //
    // The `⚡ Step N` label is the opposite: it describes the slice, not each
    // row in it, so it is stamped on the opening row alone (below). Spreading
    // it from here painted it once per event — the duplicate `⚡ Step 1` above
    // both halves of a `[text, bashCommand]` batch.
    const activityMeta = message.isActivity
      ? {
          activityKey: message.activityKey,
          promptUndo,
        }
      : {};

    if (message.isActivity) {
      const activityEvents = message.activityEvents ?? [];
      const activityOutput: CliOutputType = {
        ...output,
        response: message.activityText ?? "",
        structured: {
          ...output.structured,
          events: activityEvents,
          metadata: output.structured?.metadata ?? {},
        },
        isStreaming: false,
      };
      // Activity rows are already attributed to the step and intentionally do
      // not repeat the aggregate attempt header/prompt/command.
      output = activityOutput;
    }

    if (emitsLeadingChrome && output.prompt && !scriptish) {
      rows.push({
        key: `${attemptRowKeyBase}:prompt`,
        rowKind: OUTPUT_ROW_KINDS.PROMPT,
        target,
        text: output.prompt,
        estimateSize: 36,
      });
    }

    if (emitsLeadingChrome && output.cliCommand) {
      rows.push({
        key: `${attemptRowKeyBase}:command`,
        rowKind: scriptish
          ? OUTPUT_ROW_KINDS.SCRIPT_COMMAND
          : OUTPUT_ROW_KINDS.CLI_COMMAND,
        target,
        workingDirectory: output.workingDirectory,
        command: output.cliCommand,
        wasInjected: output.cliCommandWasInjected,
        estimateSize: 32,
      });
    }

    if (emitsLeadingChrome && output.errorMessage) {
      rows.push({
        key: `${attemptRowKeyBase}:error`,
        rowKind: OUTPUT_ROW_KINDS.ERROR,
        target,
        timestamp: output.timestampMs
          ? new Date(output.timestampMs).toLocaleTimeString("en-US", {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
              hour12: false,
            })
          : undefined,
        errorMessage: output.errorMessage,
        estimateSize: 32,
      });
    }

    // Where this slice's own content begins. The leading chrome pushed above
    // (header/prompt/command/error) belongs to the *attempt*, not the slice, so
    // attribution must not land on it — the label goes above the first content
    // row and nowhere else.
    const contentRowStart = rows.length;

    const rawTextOutput = getRawTextOutput(output);
    // Tool call bodies sit in ToolCallBlock's content column, right of the ●
    // gutter. Diffs don't — they render full-bleed and keep the whole width.
    const toolCallContentWidth =
      input.outputContentWidth != null
        ? input.outputContentWidth -
          toolCallGutterWidth(input.outputFontSize ?? 13)
        : undefined;
    // Must use the ⎿ line's real geometry, not the prose allowance: this budget
    // decides how much text BashOutput actually renders, so any disagreement
    // with estimateBashOutputHeight's width shows up directly as measurement
    // drift when the row is realized.
    const collapsedToolOutputMaxCharacters = getCollapsedOutputMaxChars({
      maxLines: collapsedToolOutputLineCount,
      contentWidth: toolCallContentWidth,
      outputFontSize: Math.max(10, (input.outputFontSize ?? 13) - 1),
      horizontalChrome:
        OUTPUT_ROW_HORIZONTAL_PADDING +
        toolResultPrefixWidth(input.outputFontSize ?? 13),
    });
    const streamingChunk = message.isActivity
      ? ""
      : getStreamingChunk(
          input,
          target,
          message.phase,
          message.runIndex,
          message.attemptIndex
        );
    const visibleEvents = getVisibleStructuredEvents(output.structured?.events);
    const hasStructuredEvents = visibleEvents.length > 0;

    if (hasStructuredEvents && output.isStreaming && streamingChunk) {
      rows.push({
        key: `${rowKeyBase}:streaming-text`,
        rowKind: OUTPUT_ROW_KINDS.PLAIN_RESPONSE,
        target,
        text: streamingChunk,
        rawTextOutput,
        animated: !isScriptOutput(output),
        ...activityMeta,
        estimateSize: 120,
      });
    }

    for (const visibleEvent of visibleEvents) {
      const rowKey = `${rowKeyBase}:event:${visibleEvent.originalIndex}`;
      // The diff key is both the collapse/expansion state key and the diff
      // row's DOM anchor id, so it needs the same per-slice uniqueness as
      // `rowKey` — see `getRowKeyBase`. Two diffs sharing it shared one
      // collapsed/expanded state, and a diff row's height is baked in from
      // that state at build time.
      const diffKeyBase = `${getOutputDiffKey(
        target,
        target.index,
        runIndex,
        attemptIndex,
        visibleEvent.originalIndex
      )}${message.isActivity && message.activityKey ? `-s${message.activityKey}` : ""}`;
      const diffExpandedGaps = input.diffExpansionState.get(diffKeyBase);
      const isDiffCollapsed =
        input.diffCollapseState.get(diffKeyBase) ?? input.defaultDiffCollapsed;
      const diffStats =
        !visibleEvent.hideDiff &&
        (visibleEvent.event.type === CLI_EVENT_TYPES.FILE_EDIT ||
          visibleEvent.event.type === CLI_EVENT_TYPES.FILE_WRITE ||
          visibleEvent.event.type === CLI_EVENT_TYPES.FILE_DELETE)
          ? computeOutputDiffStats(visibleEvent.event, workspaceSnapshot, {
              viewType: input.diffViewType ?? "unified",
              collapsed: isDiffCollapsed,
              expandedGaps: diffExpandedGaps,
              outputFontSize: input.outputFontSize,
              outputContentWidth: input.outputContentWidth,
            })
          : null;
      const diffKey =
        diffStats && diffStats.added + diffStats.removed > 0
          ? diffKeyBase
          : null;
      const toolCallExpansion =
        visibleEvent.event.type === CLI_EVENT_TYPES.TOOL_CALL ||
        visibleEvent.event.type === CLI_EVENT_TYPES.MCP_TOOL_CALL
          ? (input.toolCallExpansionState.get(rowKey) ??
            DEFAULT_TOOL_CALL_EXPANSION_STATE)
          : undefined;
      const toolCallRenderPlan =
        visibleEvent.event.type === CLI_EVENT_TYPES.TOOL_CALL ||
        visibleEvent.event.type === CLI_EVENT_TYPES.MCP_TOOL_CALL
          ? buildToolCallRenderPlan({
              parameters: (
                visibleEvent.event.data as ToolCall | McpToolCallData
              ).parameters,
              result: (visibleEvent.event.data as ToolCall | McpToolCallData)
                .result,
              expansion: toolCallExpansion,
              outputFontSize: input.outputFontSize,
              outputContentWidth: toolCallContentWidth,
              maxResultLines: collapsedToolOutputLineCount,
            })
          : undefined;

      rows.push({
        key: rowKey,
        rowKind: OUTPUT_ROW_KINDS.STRUCTURED_EVENT,
        target,
        event: visibleEvent.event,
        eventIndex: visibleEvent.originalIndex,
        rawTextOutput,
        attemptIndex: visibleEvent.originalIndex,
        workspaceSnapshot,
        undoRecord,
        hideDiff: visibleEvent.hideDiff,
        ...activityMeta,
        showParamsLabel,
        bashExpansion:
          visibleEvent.event.type === CLI_EVENT_TYPES.BASH_COMMAND
            ? input.bashExpansionState?.get(rowKey)
            : undefined,
        collapsedToolOutputLineCount,
        collapsedToolOutputMaxCharacters:
          visibleEvent.event.type === CLI_EVENT_TYPES.BASH_COMMAND
            ? collapsedToolOutputMaxCharacters
            : undefined,
        diff:
          diffKey && diffStats
            ? {
                key: diffKey,
                addedLines: diffStats.added,
                removedLines: diffStats.removed,
                runs: diffStats.runs,
                isCollapsed: isDiffCollapsed,
                expandedGaps: diffExpandedGaps,
                renderPlan: diffStats.renderPlan,
              }
            : undefined,
        toolCall:
          toolCallExpansion && toolCallRenderPlan
            ? {
                expansion: toolCallExpansion,
                renderPlan: toolCallRenderPlan,
              }
            : undefined,
        estimateSize: 64,
      });
    }

    if (!hasStructuredEvents) {
      const attemptKey = rowKeyBase;
      if (output.isStreaming && streamingChunk) {
        if (isScriptOutput(output)) {
          pushScriptOutputRows({
            rows,
            baseKey: `${attemptKey}:streaming-response`,
            target,
            text: streamingChunk,
            capToTail: true,
            expansionState: input.scriptOutputExpansionState,
          });
        } else {
          rows.push({
            key: `${attemptKey}:streaming-response`,
            rowKind: OUTPUT_ROW_KINDS.PLAIN_RESPONSE,
            target,
            text: streamingChunk,
            rawTextOutput,
            animated: true,
            ...activityMeta,
            estimateSize: 120,
          });
        }
      } else if (!output.isStreaming && output.response) {
        if (isScriptOutput(output)) {
          pushScriptOutputRows({
            rows,
            baseKey: `${attemptKey}:response`,
            target,
            text: output.response,
            capToTail: false,
            expansionState: input.scriptOutputExpansionState,
          });
        } else {
          rows.push({
            key: `${attemptKey}:response`,
            rowKind: OUTPUT_ROW_KINDS.PLAIN_RESPONSE,
            target,
            text: output.response,
            rawTextOutput,
            animated: false,
            ...activityMeta,
            estimateSize: 120,
          });
        }
      }
    }

    // The label lands on the slice's first content row and nowhere else, so it
    // appears once per contiguous run of a step's rows rather than once per
    // event. `outputRowActivityChrome` charges 20px per flagged row, so this is
    // also what keeps the estimate matched to what actually renders.
    const sliceOpener =
      message.isActivity && stampActivityFirst && rows.length > contentRowStart
        ? rows[contentRowStart]
        : undefined;
    if (sliceOpener) {
      sliceOpener.activityFirst = true;
      sliceOpener.activityLabel = stepLabel;
      sliceOpener.activityName = stepName;
    }

    if (emitsTrailingChrome && aggregateOutput.scriptVerdict) {
      const verdictKey = `${attemptRowKeyBase}:verdict`;
      rows.push({
        key: verdictKey,
        rowKind: OUTPUT_ROW_KINDS.SCRIPT_VERDICT,
        target,
        verdict: aggregateOutput.scriptVerdict,
        expanded: input.scriptVerdictExpansionState?.get(verdictKey) ?? false,
        estimateSize: 36,
      });
    }

    const hasStatsRow = isScriptOutput(aggregateOutput)
      ? !aggregateOutput.isStreaming &&
        (aggregateOutput.exitCode !== undefined ||
          aggregateOutput.elapsed !== undefined ||
          !!outputText)
      : !!aggregateOutput.tokens ||
        aggregateOutput.elapsed !== undefined ||
        !!aggregateOutput.structured?.metadata?.sessionId ||
        (!!outputText && !aggregateOutput.isStreaming);

    if (emitsTrailingChrome && hasStatsRow) {
      rows.push({
        key: `${attemptRowKeyBase}:stats`,
        rowKind: OUTPUT_ROW_KINDS.STATS,
        target,
        output: aggregateOutput,
        outputText,
        estimateSize: 24,
      });
    }

    if (rows.length > groupStartIndex) {
      // The block's top padding and bottom border belong to the attempt, not to
      // each activity slice inside it: `cli-header` is always the first row and
      // `stats` the last, which is what `outputRowGroupPadding` estimates
      // against. Flagging every slice drew a rule under each interleaved
      // fragment and charged the padding to rows that never render it.
      if (emitsLeadingChrome) rows[groupStartIndex].groupStart = true;
      if (emitsTrailingChrome) rows[rows.length - 1].groupEnd = true;
    }
  }

  return {
    // Estimate against the published copy, not the draft it was spread from:
    // `estimateOutputRowHeight` memoizes on the row object, and the virtualizer
    // only ever sees the copy. Estimating the draft would leave every published
    // row cold and cost the first `estimateSize` sweep a second full pass.
    rows: rows.map((row) => {
      const publishedRow = {
        ...row,
        stepColor: getStepOutputColor(row.target),
      };
      publishedRow.estimateSize = estimateOutputRowHeight(
        publishedRow,
        input.outputFontSize,
        input.outputContentWidth
      );
      return publishedRow;
    }),
    uniqueStepTargets: [...uniqueTargets.values()],
    stepOutputsMap,
    lastCliIndexPerStep,
    firstRowIndexByTarget,
    anchorRowIndexByTarget,
    latestActivityRowKey: (() => {
      const latestActivity = [...input.allMessages]
        .reverse()
        .find((message) => message.isActivity && message.activityKey);
      if (!latestActivity?.activityKey) return undefined;
      return rows.find((row) => row.activityKey === latestActivity.activityKey)
        ?.key;
    })(),
  };
}
