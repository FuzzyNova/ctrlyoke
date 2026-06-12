import type { WorkflowStep } from "@store/workflowStore";
import { CLI_EVENT_TYPES, FINAL_STEP_PHASES } from "../types/messages";
import type {
  CliOutput as CliOutputType,
  CliEvent,
  OutputStatusMessage,
  ToolCall,
} from "../types/cliEvents";
import type {
  StepOutput,
  UndoRecord,
  WorkspaceSnapshot,
  WorkflowOutputHistory,
  WorkflowRunMetadata,
} from "@root/types/OutputHistoryTypes";
import { sanitizeTerminalOutput } from "@root/utils/TerminalOutputSanitizer";
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
  DEFAULT_COLLAPSED_OUTPUT_MAX_CHARS,
  DEFAULT_COLLAPSED_OUTPUT_MAX_LINES,
  buildCollapsedOutputPreview,
} from "./outputTruncation";
import { formatCliCommandDisplay } from "./outputCommandDisplay";
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

export interface HistoryBannerRow extends OutputRowBase {
  rowKind: "history-banner";
  historyOutputs: NonNullable<BuildOutputRowsInput["historyOutputs"]>;
  showBackToLive: boolean;
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
  hideDiff: boolean;
}

export interface PlainResponseRow extends OutputRowBase {
  rowKind: "plain-response";
  target: OutputMessageTarget;
  text: string;
  rawTextOutput: boolean;
  animated: boolean;
}

export interface StatsRow extends OutputRowBase {
  rowKind: "stats";
  target: OutputMessageTarget;
  output: CliOutputType;
  outputText?: string;
}

export type OutputRenderRow =
  | HistoryBannerRow
  | StepAnchorRow
  | FinalStepLabelRow
  | StatusRow
  | CliHeaderRow
  | PromptRow
  | CliCommandRow
  | ErrorRow
  | StructuredEventRow
  | PlainResponseRow
  | StatsRow;

export interface BuildOutputRowsInput {
  allMessages: readonly OutputMessage[];
  steps: readonly WorkflowStep[];
  finalStep: WorkflowStep | null | undefined;
  streamingChunks: Record<number, string>;
  finalStepStreamingChunks: Record<number, string>;
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
  defaultDiffCollapsed: boolean;
  diffViewType?: "split" | "unified";
  outputFontSize?: number;
  outputContentWidth?: number;
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
  target: OutputMessageTarget
): string {
  return target.kind === FINAL_STEP_PHASES.QUEUE
    ? input.streamingChunks[target.index] || ""
    : input.finalStepStreamingChunks[target.index] || "";
}

const DEFAULT_OUTPUT_CONTENT_WIDTH = 760;
const MIN_OUTPUT_CONTENT_WIDTH = 240;
const OUTPUT_ROW_HORIZONTAL_CHROME = 72;
const HEADER_HORIZONTAL_CHROME = 140;
const STATS_HORIZONTAL_CHROME = 96;
const OUTPUT_BLOCK_VERTICAL_CHROME = 32;
const TERMINAL_LINE_VERTICAL_CHROME = 12;
const THINKING_LABEL_HEIGHT = 18;
const THINKING_CONTENT_VERTICAL_CHROME = 14;
const THINKING_OUTER_VERTICAL_CHROME = 6;
const STATUS_ROW_VERTICAL_CHROME = 20;
const HEADER_VERTICAL_CHROME = 11; // pb-spacing-xs(4) + border-b(1) + mb-spacing-sm(6)
const STATS_VERTICAL_CHROME = 10;
const BASH_RESULT_MAX_LINES = DEFAULT_COLLAPSED_OUTPUT_MAX_LINES;
const BASH_RESULT_MAX_CHARS = DEFAULT_COLLAPSED_OUTPUT_MAX_CHARS;

function normalizeTextForLayout(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\t/g, "    ");
}

function resolveContentWidth(
  outputContentWidth?: number,
  chrome = OUTPUT_ROW_HORIZONTAL_CHROME
): number {
  const baseWidth =
    outputContentWidth && outputContentWidth > 0
      ? outputContentWidth
      : DEFAULT_OUTPUT_CONTENT_WIDTH;
  return Math.max(MIN_OUTPUT_CONTENT_WIDTH, baseWidth - chrome);
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
  const normalized = normalizeTextForLayout(text);
  if (normalized.length === 0) {
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

  return normalized.split("\n").reduce((total, rawLine) => {
    if (rawLine.length === 0) {
      return total + emptyLineWeight;
    }
    return total + Math.max(1, Math.ceil(rawLine.length / charsPerLine));
  }, 0);
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

function estimateMarkdownBlockHeight(
  text: string,
  outputContentWidth: number | undefined,
  outputFontSize: number
): number {
  // emptyLineWeight: 0.5 — \n\n paragraph breaks render as compact margins
  // (~half a line height), not as full blank lines. Without this, long AI
  // responses with many paragraph breaks are consistently over-estimated by
  // 10-15%, which the bucket correction can't fix (it only scales upward).
  const baseHeight = estimateTextBlockHeight(
    text,
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
  const headingCount = (text.match(/^#{1,6}\s+/gm) ?? []).length;
  const bulletCount = (text.match(/^\s*(?:[-*+]|\d+\.)\s+/gm) ?? []).length;
  const codeFenceCount = Math.floor((text.match(/^```/gm) ?? []).length / 2);
  const blockQuoteCount = (text.match(/^\s*>\s+/gm) ?? []).length;

  // Markdown tables: th/td render with py-1.5 (12px padding) + 1px border,
  // making each visible row taller than a plain text line. Separator rows
  // (|---|) count as full text lines in the base estimate but render as 0px.
  const tableRowMatches = text.match(/^\|.+\|/gm) ?? [];
  const tableSeparatorCount = tableRowMatches.filter((r) =>
    /^\|\s*[-: |]+$/.test(r)
  ).length;
  const tableVisibleRowCount = tableRowMatches.length - tableSeparatorCount;
  // lineHeight matches the markdown base estimate (1.6 multiplier) so that
  // the separator row subtraction cancels exactly what baseHeight counted.
  const tableLineHeight = Math.max(16, outputFontSize * 1.6);
  // Base correction (24) was calibrated at FS=13. Scale up for larger fonts
  // since table content in narrow columns wraps more at higher font sizes.
  const tableRowCorrection =
    24 + Math.max(0, Math.round((outputFontSize - 13) * 2.0));
  const tableCorrection =
    tableVisibleRowCount > 0
      ? tableVisibleRowCount * tableRowCorrection +
        16 -
        tableSeparatorCount * tableLineHeight
      : 0;

  return (
    baseHeight +
    headingCount * 8 +
    bulletCount * 2 +
    codeFenceCount * 14 +
    blockQuoteCount * 6 +
    tableCorrection
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

function estimateTerminalSummaryHeight(
  text: string,
  outputContentWidth: number | undefined,
  outputFontSize: number,
  verticalChrome = TERMINAL_LINE_VERTICAL_CHROME
): number {
  const lineCount = estimateWrappedLineCount(
    text,
    outputContentWidth,
    outputFontSize,
    {
      chrome: OUTPUT_ROW_HORIZONTAL_CHROME,
      charWidthMultiplier: 0.6,
    }
  );
  return (
    Math.max(1, lineCount) * Math.max(18, outputFontSize * 1.55) +
    verticalChrome
  );
}

function estimateFileOperationHeaderHeight(
  actionLabel: string,
  path: string,
  outputContentWidth: number | undefined,
  outputFontSize: number,
  error?: string
): number {
  const availableWidth = resolveContentWidth(
    outputContentWidth,
    OUTPUT_ROW_HORIZONTAL_CHROME
  );
  const charWidth = Math.max(5.5, outputFontSize * 0.6);
  const lineHeight = Math.max(18, outputFontSize * 1.55);
  const gapWidth = Math.max(4, outputFontSize * 0.35);
  const dotWidth = charWidth;
  const actionWidth = actionLabel.length * charWidth;
  const prefixWidth = dotWidth + gapWidth + actionWidth + gapWidth;
  const pathWidth = Math.max(64, availableWidth - prefixWidth);
  const pathCharsPerLine = Math.max(8, Math.floor(pathWidth / charWidth));
  const pathLineCount = Math.max(1, Math.ceil(path.length / pathCharsPerLine));
  const errorLineCount = error
    ? Math.max(
        1,
        estimateWrappedLineCount(error, outputContentWidth, outputFontSize, {
          chrome: OUTPUT_ROW_HORIZONTAL_CHROME,
          charWidthMultiplier: 0.6,
        })
      )
    : 0;

  return (
    pathLineCount * lineHeight +
    errorLineCount * lineHeight +
    TERMINAL_LINE_VERTICAL_CHROME
  );
}

function estimateBashOutputHeight(
  event: CliEvent,
  outputContentWidth: number | undefined,
  outputFontSize: number,
  expansion?: OutputRowBashExpansionState
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
  // TOOL_CALL_TERMINAL has my-2=16px total vertical margin (captured via
  // flow-root). Split as 8px for command + 8px for result = 16px total.
  let totalHeight = estimateTerminalSummaryHeight(
    commandText,
    outputContentWidth,
    outputFontSize,
    8
  );

  const isCompleted =
    data.status === undefined ||
    data.status === "completed" ||
    data.status === "failed";
  if (!isCompleted) {
    return totalHeight;
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
      maxLines: BASH_RESULT_MAX_LINES,
      maxChars: BASH_RESULT_MAX_CHARS,
    });
    totalHeight += estimateTextBlockHeight(
      preview.visibleText,
      outputContentWidth,
      outputFontSize,
      {
        charWidthMultiplier: 0.6,
        // TOOL_RESULT_LINE uses sm font (FS-1) with leading-relaxed (1.625).
        // 1.55 × FS approximates max(16, (FS-1) × 1.625) for the valid FS range.
        lineHeightMultiplier: 1.55,
        verticalChrome: 8, // my-2 bottom half (see command chrome above)
      }
    );
    if (preview.isTruncated) {
      totalHeight += Math.max(16, outputFontSize * 1.4);
    }
  }

  return totalHeight;
}

function estimateStructuredTextHeight(
  row: StructuredEventRow,
  outputContentWidth: number | undefined,
  outputFontSize: number
): number {
  switch (row.event.type) {
    case CLI_EVENT_TYPES.TEXT: {
      const text = (row.event.data as { text?: string }).text ?? "";
      return row.rawTextOutput
        ? estimateTextBlockHeight(text, outputContentWidth, outputFontSize)
        : estimateMarkdownBlockHeight(text, outputContentWidth, outputFontSize);
    }
    case CLI_EVENT_TYPES.THINKING: {
      const text = (row.event.data as { text?: string }).text ?? "";
      const contentHeight = estimateTextBlockHeight(
        text,
        outputContentWidth,
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
        row.bashExpansion
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
        outputContentWidth,
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
        outputContentWidth,
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
    outputContentWidth
  );
}

export function estimateOutputRowHeight(
  row: OutputRenderRow,
  outputFontSize = 13,
  outputContentWidth?: number
): number {
  switch (row.rowKind) {
    case "history-banner":
      return 44;
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

export function buildOutputRows(
  input: BuildOutputRowsInput
): BuildOutputRowsResult {
  const rows: OutputRenderRow[] = [];
  const stepOutputsMap = new Map<string, CliOutputType[]>();
  const lastCliIndexPerStep = new Map<string, number>();
  const uniqueTargets = new Map<string, OutputMessageTarget>();
  const firstRowIndexByTarget = new Map<string, number>();

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

  if (input.isViewingHistory && input.historyOutputs) {
    rows.push({
      key: "history-banner",
      rowKind: "history-banner",
      historyOutputs: input.historyOutputs,
      showBackToLive: input.isExecutionActive,
      estimateSize: 44,
    });
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
    const streamingChunk = getStreamingChunk(input, target);
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
              outputContentWidth: input.outputContentWidth,
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
      if (output.isStreaming && streamingChunk) {
        rows.push({
          key: `${targetKey}:run${runIndex}:attempt${attemptIndex}:streaming-response`,
          rowKind: "plain-response",
          target,
          text: streamingChunk,
          rawTextOutput: isScriptOutput(output) ? true : rawTextOutput,
          animated: !isScriptOutput(output),
          estimateSize: 120,
        });
      } else if (!output.isStreaming && output.response) {
        rows.push({
          key: `${targetKey}:run${runIndex}:attempt${attemptIndex}:response`,
          rowKind: "plain-response",
          target,
          text: output.response,
          rawTextOutput: isScriptOutput(output) ? true : rawTextOutput,
          animated: false,
          estimateSize: 120,
        });
      }
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
