import type { WorkflowStep } from "@store/workflowStore";
import {
  CLI_EVENT_TYPES,
  FINAL_STEP_PHASES,
  getStreamingChunkKey,
  type ExecutionPhase,
} from "../types/messages";
import type {
  CliOutput as CliOutputType,
  CliEvent,
  OutputStatusMessage,
  ToolCall,
} from "../types/cliEvents";
import type { ScriptVerdict } from "@root/types/CtrlYokeTypes";
import {
  WORKFLOW_TOKEN_COVERAGE,
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
  TOOL_CALL_BLOCK_HALF_VERTICAL_CHROME,
  TOOL_CALL_BLOCK_VERTICAL_CHROME,
  estimateFileOperationHeaderLines,
  outputRowGroupPadding,
  resolveOutputContentWidth,
  toolCallGutterWidth,
  toolCallLineHeight,
  toolResultLineHeight,
  toolResultPrefixWidth,
} from "./outputLineMetrics";
import type { DiffRenderPlan } from "./rdvAdapter";

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

interface OutputRowBase {
  key: string;
  target?: OutputMessageTarget;
  estimateSize: number;
  groupStart?: boolean;
  groupEnd?: boolean;
}

export interface AttemptGroupSummaryRow extends OutputRowBase {
  rowKind: "attempt-group-summary";
  target: OutputMessageTarget;
  groupKey: string;
  attemptCount: number;
  total?: number;
  coverage: WorkflowTokenCoverage;
}

export interface StepAnchorRow extends OutputRowBase {
  rowKind: "step-anchor";
  target: OutputMessageTarget;
}

export interface FinalStepLabelRow extends OutputRowBase {
  rowKind: "final-step-label";
  target: OutputMessageTarget;
  label: string;
}

export interface StatusRow extends OutputRowBase {
  rowKind: "status";
  target: OutputMessageTarget;
  status: OutputStatusMessage;
}

export interface CliHeaderRow extends OutputRowBase {
  rowKind: "cli-header";
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

export interface PromptRow extends OutputRowBase {
  rowKind: "prompt";
  target: OutputMessageTarget;
  text: string;
}

export interface CliCommandRow extends OutputRowBase {
  rowKind: "cli-command";
  target: OutputMessageTarget;
  workingDirectory?: string;
  command: string;
  wasInjected?: boolean;
}

export interface ErrorRow extends OutputRowBase {
  rowKind: "error";
  target: OutputMessageTarget;
  timestamp?: string;
  errorMessage: string;
}

export interface StructuredEventRow extends OutputRowBase {
  rowKind: "structured-event";
  target: OutputMessageTarget;
  event: CliEvent;
  eventIndex: number;
  rawTextOutput: boolean;
  attemptIndex: number;
  workspaceSnapshot?: WorkspaceSnapshot;
  undoRecord?: UndoRecord;
  diff?: OutputRowDiffMeta;
  toolCall?: OutputRowToolCallMeta;
  bashExpansion?: OutputRowBashExpansionState;
  collapsedToolOutputLineCount?: number;
  /** Width-aware character budget backing the collapsed Bash preview. */
  collapsedToolOutputMaxCharacters?: number;
  hideDiff: boolean;
}

export interface PlainResponseRow extends OutputRowBase {
  rowKind: "plain-response";
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
export interface ScriptOutputRow extends OutputRowBase {
  rowKind: "script-output";
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

export interface StatsRow extends OutputRowBase {
  rowKind: "stats";
  target: OutputMessageTarget;
  output: CliOutputType;
  outputText?: string;
}

export interface ScriptVerdictRow extends OutputRowBase {
  rowKind: "script-verdict";
  target: OutputMessageTarget;
  verdict: ScriptVerdict;
  expanded: boolean;
}

export type OutputRenderRow =
  | StepAnchorRow
  | FinalStepLabelRow
  | StatusRow
  | CliHeaderRow
  | PromptRow
  | CliCommandRow
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
  defaultDiffCollapsed: boolean;
  diffViewType?: "split" | "unified";
  outputFontSize?: number;
  outputContentWidth?: number;
  /** Approximate number of wrapped result lines shown before Bash and generic tool output collapses. */
  collapsedToolOutputLineCount?: number;
}

interface AttemptGroupAggregate {
  key: string;
  target: OutputMessageTarget;
  firstMessageIndex: number;
  attempts: Map<string, CliOutputType>;
}

function getAttemptGroupKey(message: OutputMessage): string | undefined {
  if (message.type !== "cli") return undefined;
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
    if (!groupKey || message.type !== "cli") continue;
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
}

function getStepName(
  step: WorkflowStep | null | undefined,
  fallback: string
): string {
  const name = step?.name?.trim();
  return name || fallback;
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
  phase?: ExecutionPhase
): string {
  return target.kind === FINAL_STEP_PHASES.QUEUE
    ? input.streamingChunks[getStreamingChunkKey(target.index, phase)] || ""
    : input.finalStepStreamingChunks[
        getStreamingChunkKey(target.index, phase)
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
  count: number;
}

const wrappedLineCountCache = new Map<string, WrappedLineCountCacheEntry>();

function countWrappedLines(
  text: string,
  charsPerLine: number,
  emptyLineWeight: number
): number {
  return normalizeTextForLayout(text)
    .split("\n")
    .reduce((total, rawLine) => {
      if (rawLine.length === 0) {
        return total + emptyLineWeight;
      }
      return total + Math.max(1, Math.ceil(rawLine.length / charsPerLine));
    }, 0);
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

  if (text.length < WRAPPED_LINE_COUNT_CACHE_MIN_CHARS) {
    return countWrappedLines(text, charsPerLine, emptyLineWeight);
  }

  const cached = wrappedLineCountCache.get(text);
  if (
    cached &&
    cached.charsPerLine === charsPerLine &&
    cached.emptyLineWeight === emptyLineWeight
  ) {
    return cached.count;
  }

  const count = countWrappedLines(text, charsPerLine, emptyLineWeight);
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
  wrappedLineCountCache.set(text, { charsPerLine, emptyLineWeight, count });
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
    data.status === "completed" ||
    data.status === "failed";
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
    case CLI_EVENT_TYPES.MCP_TOOL_CALL: {
      const data = row.event.data as { server?: string; tool?: string };
      return estimateTerminalSummaryHeight(
        `MCP ${data.server ?? "server"}.${data.tool ?? "tool"}`,
        outputContentWidth,
        outputFontSize
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
    default:
      return 64;
  }
}

function estimateBaseStructuredEventHeight(
  row: StructuredEventRow,
  outputContentWidth: number | undefined,
  outputFontSize: number
): number {
  if (row.event.type === CLI_EVENT_TYPES.TOOL_CALL && row.toolCall) {
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
  if (row.event.type !== CLI_EVENT_TYPES.TOOL_CALL || !row.toolCall) {
    return 64;
  }

  // When content width is known, recompute with wrapping-aware estimation —
  // renderPlan.totalHeight was built without content width and underestimates
  // heavily for tool calls with long output lines (whitespace-pre-wrap).
  if (row.toolCall.renderPlan && outputContentWidth == null) {
    return row.toolCall.renderPlan.totalHeight;
  }

  const data = row.event.data as ToolCall;
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

export function estimateOutputRowHeight(
  row: OutputRenderRow,
  outputFontSize = 13,
  outputContentWidth?: number
): number {
  // Rows at a CLI group's edges get extra padding from OutputRow's wrapper.
  // Only rows that carry the flags are wrapped, so this is safe to add
  // unconditionally — and it is the whole story behind the persistent bias on
  // `stats` (always a group's last row) and `cli-header` (always its first).
  return (
    estimateOutputRowContentHeight(row, outputFontSize, outputContentWidth) +
    outputRowGroupPadding(row)
  );
}

function estimateOutputRowContentHeight(
  row: OutputRenderRow,
  outputFontSize: number,
  outputContentWidth?: number
): number {
  switch (row.rowKind) {
    case "step-anchor":
      return 1;
    case "final-step-label":
      return 24;
    case "status":
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
    case "cli-header":
      return estimateCliHeaderHeight(row, outputContentWidth, outputFontSize);
    case "prompt":
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
        }
      );
    case "cli-command":
      // OUTPUT_BLOCK_BASE: font-mono sm font, body line-height:1.4, py-sm+my-sm=24px chrome.
      // chrome:32 matches actual horizontal padding (px-md outer + px-sm inner + border-l-3).
      return estimateTextBlockHeight(
        formatCliCommandDisplay(
          row.command,
          row.workingDirectory,
          row.wasInjected
        ),
        outputContentWidth,
        outputFontSize - 1,
        {
          charWidthMultiplier: 0.6,
          lineHeightMultiplier: 1.4,
          verticalChrome: 24,
          chrome: 32,
        }
      );
    case "error":
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
    case "plain-response":
      return row.rawTextOutput
        ? estimateTextBlockHeight(row.text, outputContentWidth, outputFontSize)
        : estimateMarkdownBlockHeight(
            row.text,
            outputContentWidth,
            outputFontSize
          );
    case "script-output":
      return estimateScriptOutputHeight(
        row,
        outputContentWidth,
        outputFontSize
      );
    case "script-verdict":
      return row.expanded
        ? 220
        : estimateCollapsedScriptVerdictHeight(
            row,
            outputContentWidth,
            outputFontSize
          );
    case "attempt-group-summary":
      return 36;
    case "stats":
      return estimateStatsRowHeight(row, outputContentWidth, outputFontSize);
    case "structured-event":
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
      rowKind: "script-output",
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
  const uniqueTargets = new Map<string, OutputMessageTarget>();
  const firstRowIndexByTarget = new Map<string, number>();
  const collapsedToolOutputLineCount =
    input.collapsedToolOutputLineCount ?? DEFAULT_COLLAPSED_OUTPUT_MAX_LINES;
  const attemptGroups = new Map<string, AttemptGroupAggregate>();
  const attemptGroupByMessageIndex = new Map<number, string>();

  for (const [messageIndex, message] of input.allMessages.entries()) {
    const groupKey = getAttemptGroupKey(message);
    if (!groupKey || message.type !== "cli") continue;
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

    if (message.type === "cli") {
      const stepOutputs = stepOutputsMap.get(targetKey) ?? [];
      stepOutputs.push(message.data as CliOutputType);
      stepOutputsMap.set(targetKey, stepOutputs);
      lastCliIndexPerStep.set(targetKey, messageIndex);
    }
  }

  for (const [messageIndex, message] of input.allMessages.entries()) {
    const target = message.target;
    const targetKey = getTargetKey(target);
    const isFirstForTarget = !firstRowIndexByTarget.has(targetKey);
    if (isFirstForTarget) {
      firstRowIndexByTarget.set(targetKey, rows.length);
      rows.push({
        key: `${targetKey}:anchor`,
        rowKind: "step-anchor",
        target,
        estimateSize: 1,
      });
      if (target.kind === FINAL_STEP_PHASES.FINAL_STEP) {
        rows.push({
          key: `${targetKey}:final-step-label`,
          rowKind: "final-step-label",
          target,
          label: `Final Step Loop ${target.index + 1}`,
          estimateSize: 24,
        });
      }
    }

    if (message.type === "status") {
      rows.push({
        key: `${targetKey}:status:${messageIndex}`,
        rowKind: "status",
        target,
        status: message.data as OutputStatusMessage,
        estimateSize: 36,
      });
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
        rowKind: "attempt-group-summary",
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

    const output = message.data as CliOutputType;
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
    const outputText = getCliTextForCopy(output);
    const { workspaceSnapshot, undoRecord } = getStepOutputArtifacts(
      input,
      target
    );
    const allStepOutputs = stepOutputsMap.get(targetKey) ?? [];
    const isLastCliForStep =
      lastCliIndexPerStep.get(targetKey) === messageIndex;
    const promptUndoActions =
      input.allowUndoActions && isLastCliForStep && !output.isStreaming
        ? computePromptUndoActions(
            allStepOutputs,
            undoRecord,
            workspaceSnapshot
          )
        : { undo: null, redo: null };

    rows.push({
      key: `${targetKey}:run${runIndex}:attempt${attemptIndex}:header`,
      rowKind: "cli-header",
      target,
      output,
      stepIndex: target.index,
      isFinalStep,
      stepLabel,
      stepName,
      attemptIndex,
      runIndex,
      promptUndo:
        promptUndoActions.undo || promptUndoActions.redo
          ? {
              workspacePath: output.workingDirectory ?? "",
              workspaceSnapshot,
              undoRecord,
              allStepOutputs,
              undo: promptUndoActions.undo,
              redo: promptUndoActions.redo,
            }
          : undefined,
      estimateSize: 44,
    });

    if (output.prompt) {
      rows.push({
        key: `${targetKey}:run${runIndex}:attempt${attemptIndex}:prompt`,
        rowKind: "prompt",
        target,
        text: output.prompt,
        estimateSize: 36,
      });
    }

    if (output.cliCommand) {
      rows.push({
        key: `${targetKey}:run${runIndex}:attempt${attemptIndex}:command`,
        rowKind: "cli-command",
        target,
        workingDirectory: output.workingDirectory,
        command: output.cliCommand,
        wasInjected: output.cliCommandWasInjected,
        estimateSize: 32,
      });
    }

    if (output.errorMessage) {
      rows.push({
        key: `${targetKey}:run${runIndex}:attempt${attemptIndex}:error`,
        rowKind: "error",
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
    const streamingChunk = getStreamingChunk(input, target, message.phase);
    const visibleEvents = getVisibleStructuredEvents(output.structured?.events);
    const hasStructuredEvents = visibleEvents.length > 0;

    if (hasStructuredEvents && output.isStreaming && streamingChunk) {
      rows.push({
        key: `${targetKey}:run${runIndex}:attempt${attemptIndex}:streaming-text`,
        rowKind: "plain-response",
        target,
        text: streamingChunk,
        rawTextOutput,
        animated: !isScriptOutput(output),
        estimateSize: 120,
      });
    }

    for (const visibleEvent of visibleEvents) {
      const rowKey = `${targetKey}:run${runIndex}:attempt${attemptIndex}:event:${visibleEvent.originalIndex}`;
      const diffKeyBase = getOutputDiffKey(
        target,
        target.index,
        runIndex,
        attemptIndex,
        visibleEvent.originalIndex
      );
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
        visibleEvent.event.type === CLI_EVENT_TYPES.TOOL_CALL
          ? (input.toolCallExpansionState.get(rowKey) ??
            DEFAULT_TOOL_CALL_EXPANSION_STATE)
          : undefined;
      const toolCallRenderPlan =
        visibleEvent.event.type === CLI_EVENT_TYPES.TOOL_CALL
          ? buildToolCallRenderPlan({
              parameters: (visibleEvent.event.data as ToolCall).parameters,
              result: (visibleEvent.event.data as ToolCall).result,
              expansion: toolCallExpansion,
              outputFontSize: input.outputFontSize,
              outputContentWidth: toolCallContentWidth,
              maxResultLines: collapsedToolOutputLineCount,
            })
          : undefined;

      rows.push({
        key: rowKey,
        rowKind: "structured-event",
        target,
        event: visibleEvent.event,
        eventIndex: visibleEvent.originalIndex,
        rawTextOutput,
        attemptIndex: visibleEvent.originalIndex,
        workspaceSnapshot,
        undoRecord,
        hideDiff: visibleEvent.hideDiff,
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
      const attemptKey = `${targetKey}:run${runIndex}:attempt${attemptIndex}`;
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
            rowKind: "plain-response",
            target,
            text: streamingChunk,
            rawTextOutput,
            animated: true,
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
            rowKind: "plain-response",
            target,
            text: output.response,
            rawTextOutput,
            animated: false,
            estimateSize: 120,
          });
        }
      }
    }

    if (output.scriptVerdict) {
      const verdictKey = `${targetKey}:run${runIndex}:attempt${attemptIndex}:verdict`;
      rows.push({
        key: verdictKey,
        rowKind: "script-verdict",
        target,
        verdict: output.scriptVerdict,
        expanded: input.scriptVerdictExpansionState?.get(verdictKey) ?? false,
        estimateSize: 36,
      });
    }

    const hasStatsRow = isScriptOutput(output)
      ? !output.isStreaming &&
        (output.exitCode !== undefined ||
          output.elapsed !== undefined ||
          !!outputText)
      : !!output.tokens ||
        output.elapsed !== undefined ||
        !!output.structured?.metadata?.sessionId ||
        (!!outputText && !output.isStreaming);

    if (hasStatsRow) {
      rows.push({
        key: `${targetKey}:run${runIndex}:attempt${attemptIndex}:stats`,
        rowKind: "stats",
        target,
        output,
        outputText,
        estimateSize: 24,
      });
    }

    if (rows.length > groupStartIndex) {
      rows[groupStartIndex].groupStart = true;
      rows[rows.length - 1].groupEnd = true;
    }
  }

  return {
    rows: rows.map((row) => ({
      ...row,
      estimateSize: estimateOutputRowHeight(
        row,
        input.outputFontSize,
        input.outputContentWidth
      ),
    })),
    uniqueStepTargets: [...uniqueTargets.values()],
    stepOutputsMap,
    lastCliIndexPerStep,
    firstRowIndexByTarget,
  };
}
