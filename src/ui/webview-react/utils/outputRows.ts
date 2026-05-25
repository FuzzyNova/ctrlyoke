import type { WorkflowStep } from "@store/workflowStore";
import { CLI_EVENT_TYPES, FINAL_STEP_PHASES } from "../types/messages";
import type {
  CliOutput as CliOutputType,
  CliEvent,
  OutputStatusMessage,
} from "../types/cliEvents";
import type {
  StepOutput,
  UndoRecord,
  WorkspaceSnapshot,
  WorkflowOutputHistory,
} from "@root/types/OutputHistoryTypes";
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
    runMetadata: Pick<
      WorkflowOutputHistory,
      "runId" | "startedAt" | "completedAt" | "executionState"
    >;
  } | null;
  workspaceSnapshots: Record<number, WorkspaceSnapshot | undefined>;
  finalStepWorkspaceSnapshots: Record<number, WorkspaceSnapshot | undefined>;
  undoRecords: Record<string, UndoRecord | undefined>;
  diffCollapseState: ReadonlyMap<string, boolean>;
  defaultDiffCollapsed: boolean;
  diffViewType?: "split" | "unified";
  outputFontSize?: number;
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

function estimateStructuredEventHeight(event: CliEvent): number {
  switch (event.type) {
    case "text":
      return 120;
    case "thinking":
      return 140;
    case "bashCommand":
      return 110;
    case "fileEdit":
      return 180;
    case "fileWrite":
    case "fileDelete":
      return 72;
    case "fileRead":
      return 48;
    case "toolResult":
      return 44;
    default:
      return 64;
  }
}

function estimateDiffStructuredEventHeight(
  row: StructuredEventRow,
  outputFontSize: number
): number {
  if (!row.diff || row.event.type !== CLI_EVENT_TYPES.FILE_EDIT || row.hideDiff) {
    return estimateStructuredEventHeight(row.event);
  }

  const toolLineHeight = Math.max(22, outputFontSize * 1.7);
  const collapsedHeaderHeight = Math.max(24, outputFontSize * 1.9);
  const diffLineHeight = Math.max(18, (outputFontSize - 1) * 1.55);
  const verticalChrome = 28;

  if (row.diff.isCollapsed) {
    return toolLineHeight + collapsedHeaderHeight + verticalChrome;
  }

  const renderedRows = row.diff.runs.reduce((sum, run) => sum + run.count, 0);
  if (renderedRows === 0) {
    return toolLineHeight + collapsedHeaderHeight + verticalChrome;
  }

  return (
    toolLineHeight +
    collapsedHeaderHeight +
    verticalChrome +
    renderedRows * diffLineHeight
  );
}

export function estimateOutputRowHeight(
  row: OutputRenderRow,
  outputFontSize = 13
): number {
  switch (row.rowKind) {
    case "history-banner":
      return 44;
    case "step-anchor":
      return 1;
    case "final-step-label":
      return 24;
    case "status":
      return 36;
    case "cli-header":
      return 44;
    case "prompt":
      return 36;
    case "cli-command":
      return 32;
    case "error":
      return 32;
    case "plain-response":
      return 120;
    case "stats":
      return 24;
    case "structured-event":
      return estimateDiffStructuredEventHeight(row, outputFontSize);
  }
}

export function estimateOutputDiffBlockHeight(
  row: StructuredEventRow,
  outputFontSize = 13
): number {
  if (!row.diff || row.event.type !== CLI_EVENT_TYPES.FILE_EDIT || row.hideDiff) {
    return row.estimateSize;
  }

  const collapsedHeaderHeight = Math.max(24, outputFontSize * 1.9);
  if (row.diff.isCollapsed) {
    return collapsedHeaderHeight;
  }

  const renderedRows = row.diff.runs.reduce((sum, run) => sum + run.count, 0);
  const diffLineHeight = Math.max(18, (outputFontSize - 1) * 1.55);
  return collapsedHeaderHeight + Math.max(1, renderedRows) * diffLineHeight;
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
    const workflowStep = isFinalStep ? input.finalStep : input.steps[target.index];
    const stepName = isFinalStep
      ? getStepName(workflowStep, `Final Step Loop ${target.index + 1}`)
      : workflowStep?.name?.trim() || undefined;
    const stepLabel = isFinalStep
      ? `Final Step Loop ${target.index + 1}`
      : `Step ${target.index + 1}`;
    const attemptIndex = message.attemptIndex ?? 0;
    const runIndex = message.runIndex ?? output.runIndex ?? 0;
    const outputText = getCliTextForCopy(output);
    const { workspaceSnapshot, undoRecord } = getStepOutputArtifacts(input, target);
    const allStepOutputs = stepOutputsMap.get(targetKey) ?? [];
    const isLastCliForStep = lastCliIndexPerStep.get(targetKey) === messageIndex;
    const promptUndoActions =
      input.allowUndoActions && isLastCliForStep && !output.isStreaming
        ? computePromptUndoActions(allStepOutputs, undoRecord, workspaceSnapshot)
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
      const diffStats =
        !visibleEvent.hideDiff &&
        (visibleEvent.event.type === CLI_EVENT_TYPES.FILE_EDIT ||
          visibleEvent.event.type === CLI_EVENT_TYPES.FILE_WRITE ||
          visibleEvent.event.type === CLI_EVENT_TYPES.FILE_DELETE)
          ? computeOutputDiffStats(
              visibleEvent.event,
              workspaceSnapshot,
              input.diffViewType ?? "unified"
            )
          : null;
      const diffKey =
        diffStats && diffStats.added + diffStats.removed > 0
          ? getOutputDiffKey(
              target,
              target.index,
              runIndex,
              attemptIndex,
              visibleEvent.originalIndex
            )
          : null;

      rows.push({
        key: `${targetKey}:run${runIndex}:attempt${attemptIndex}:event:${visibleEvent.originalIndex}`,
        rowKind: "structured-event",
        target,
        event: visibleEvent.event,
        eventIndex: visibleEvent.originalIndex,
        rawTextOutput,
        attemptIndex: visibleEvent.originalIndex,
        workspaceSnapshot,
        undoRecord,
        hideDiff: visibleEvent.hideDiff,
        diff:
          diffKey && diffStats
            ? {
                key: diffKey,
                addedLines: diffStats.added,
                removedLines: diffStats.removed,
                runs: diffStats.runs,
                isCollapsed:
                  input.diffCollapseState.get(diffKey) ??
                  input.defaultDiffCollapsed,
              }
            : undefined,
        estimateSize: estimateStructuredEventHeight(visibleEvent.event),
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
      estimateSize: estimateOutputRowHeight(row, input.outputFontSize),
    })),
    uniqueStepTargets: [...uniqueTargets.values()],
    stepOutputsMap,
    lastCliIndexPerStep,
    firstRowIndexByTarget,
  };
}
