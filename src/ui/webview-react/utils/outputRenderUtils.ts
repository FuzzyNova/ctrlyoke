import { normalizeCliEvents } from "@root/utils/CliEventNormalizer";
import { expandFromRawCode } from "react-diff-view";
import type { HunkData, ViewType } from "react-diff-view";
import type {
  CliEvent,
  CliOutput as CliOutputType,
  BashCommandData,
  FileEditData,
} from "../types/cliEvents";
import {
  CLI_EVENT_TYPES,
  FINAL_STEP_PHASES,
  OPERATION_STATUS,
} from "../types/messages";
import type { WorkspaceSnapshot } from "@root/types/OutputHistoryTypes";
import { sameFilePath } from "./promptUndo";
import {
  buildDiffRenderPlanFromStats,
  getRenderedDiffStats,
  type DiffGapExpansionPlanState,
  type DiffRenderPlan,
  type RenderedDiffRun,
  toRdvFromContent,
  toRdvHunks,
} from "./rdvAdapter";
import {
  buildDiffAnchorPrefix,
  extractCliOutputText,
  isStructuredPatchMalformed,
} from "./outputUtils";
import {
  DEFAULT_OUTPUT_FONT_SIZE,
  FILE_EDIT_ACTION_LABEL,
  estimateFileOperationHeaderLines,
  toolCallGutterWidth,
} from "./outputLineMetrics";
import type { OutputMessageTarget } from "./outputProjection";

export interface VisibleStructuredEvent {
  event: CliEvent;
  originalIndex: number;
  hideDiff: boolean;
}

export interface OutputDiffStats {
  added: number;
  removed: number;
  runs: RenderedDiffRun[];
  renderPlan: DiffRenderPlan;
}

export type DiffGapExpansionState = ReadonlyMap<number, number>;

export interface ComputeOutputDiffStatsOptions {
  viewType?: ViewType;
  collapsed?: boolean;
  expandedGaps?: DiffGapExpansionState;
  outputFontSize?: number;
  outputContentWidth?: number;
}

interface AppliedDiffGapExpansionResult {
  hunks: HunkData[];
  gapExpansion: DiffGapExpansionPlanState;
}

function buildOutputDiffStats(
  renderedStats: { added: number; removed: number; runs: RenderedDiffRun[] },
  {
    viewType,
    collapsed,
    outputFontSize,
    outputContentWidth,
    hunks,
    gapExpansion,
    layoutMode = "file-edit",
    toolHeaderLines,
  }: {
    viewType: ViewType;
    collapsed: boolean;
    outputFontSize?: number;
    outputContentWidth?: number;
    hunks?: readonly HunkData[];
    gapExpansion?: DiffGapExpansionPlanState;
    layoutMode?: "file-edit" | "standalone";
    toolHeaderLines?: number;
  }
): OutputDiffStats {
  return {
    ...renderedStats,
    renderPlan: buildDiffRenderPlanFromStats(renderedStats, {
      viewType,
      collapsed,
      outputFontSize,
      outputContentWidth,
      hunks,
      layoutMode,
      gapExpansion,
      toolHeaderLines,
    }),
  };
}

export function isScriptOutput(output: CliOutputType): boolean {
  return output.source != null;
}

export function getRawTextOutput(output: CliOutputType): boolean {
  return !!output.rawTextOutput || !!output.structured?.metadata?.rawTextOutput;
}

export function getVisibleStructuredEvents(
  events: readonly CliEvent[] | undefined
): VisibleStructuredEvent[] {
  if (!events?.length) return [];

  const normalizedEvents = normalizeCliEvents(events);
  const indicesToHideDiff = new Set<number>();
  const indicesToHideRow = new Set<number>();

  for (let i = 0; i < normalizedEvents.length; i++) {
    const event = normalizedEvents[i];

    if (event.type === CLI_EVENT_TYPES.FILE_EDIT) {
      const data = event.data as FileEditData;
      if (data.status === OPERATION_STATUS.INITIATED) {
        for (let j = i + 1; j < normalizedEvents.length; j++) {
          const next = normalizedEvents[j];
          if (next.type !== CLI_EVENT_TYPES.FILE_EDIT) continue;
          const nextData = next.data as FileEditData;
          if (!nextData.path || !data.path) continue;
          if (!sameFilePath(nextData.path, data.path)) continue;
          if (nextData.status === OPERATION_STATUS.COMPLETED) {
            indicesToHideDiff.add(i);
          }
          break;
        }
      }
    }

    if (event.type === CLI_EVENT_TYPES.BASH_COMMAND) {
      const data = event.data as BashCommandData;
      if (data.status === OPERATION_STATUS.INITIATED && data.command) {
        for (let j = i + 1; j < normalizedEvents.length; j++) {
          const next = normalizedEvents[j];
          if (next.type !== CLI_EVENT_TYPES.BASH_COMMAND) continue;
          const nextData = next.data as BashCommandData;
          if (nextData.command !== data.command) continue;
          if (
            nextData.status === OPERATION_STATUS.COMPLETED ||
            nextData.status === OPERATION_STATUS.FAILED
          ) {
            indicesToHideRow.add(i);
          }
          break;
        }
      }
    }
  }

  return normalizedEvents.flatMap((event, originalIndex) => {
    if (indicesToHideRow.has(originalIndex)) {
      return [];
    }

    return [
      {
        event,
        originalIndex,
        hideDiff: indicesToHideDiff.has(originalIndex),
      },
    ];
  });
}

function getSnapshotStructuredPatch(
  path: string,
  workspaceSnapshot?: WorkspaceSnapshot
): FileEditData["structuredPatch"] | undefined {
  return workspaceSnapshot?.changedFiles.find(
    (change) =>
      change.structuredPatch &&
      change.structuredPatch.length > 0 &&
      sameFilePath(path, change.path)
  )?.structuredPatch;
}

export function getSnapshotBeforeContent(
  path: string,
  workspaceSnapshot?: WorkspaceSnapshot
): string | undefined {
  return workspaceSnapshot?.changedFiles.find(
    (change) =>
      change.beforeContent !== undefined && sameFilePath(path, change.path)
  )?.beforeContent;
}

export function getDisplayStructuredPatch(
  path: string,
  eventPatch: FileEditData["structuredPatch"] | undefined,
  workspaceSnapshot?: WorkspaceSnapshot
): FileEditData["structuredPatch"] | undefined {
  const snapshotPatch = getSnapshotStructuredPatch(path, workspaceSnapshot);
  if (!snapshotPatch || snapshotPatch.length === 0) {
    return eventPatch;
  }

  if (!eventPatch || eventPatch.length === 0) {
    return snapshotPatch;
  }

  return isStructuredPatchMalformed(eventPatch) ? snapshotPatch : eventPatch;
}

export function computeOutputDiffStats(
  event: CliEvent,
  workspaceSnapshot?: WorkspaceSnapshot,
  options: ComputeOutputDiffStatsOptions = {}
): OutputDiffStats {
  const {
    viewType = "unified",
    collapsed = false,
    expandedGaps,
    outputFontSize,
    outputContentWidth,
  } = options;

  if (event.type === CLI_EVENT_TYPES.FILE_EDIT) {
    const data = event.data as FileEditData;
    // A file-edit diff hangs under the same `● Edited <path>` header a plain
    // file-edit row renders, so the plan has to account for that header
    // wrapping. outputContentWidth is the full pane width — the header sits
    // inside ToolCallBlock's gutter, the diff below it does not.
    const resolvedFontSize = outputFontSize ?? DEFAULT_OUTPUT_FONT_SIZE;
    const toolHeaderLines = estimateFileOperationHeaderLines(
      FILE_EDIT_ACTION_LABEL,
      data.path ?? "file",
      outputContentWidth != null
        ? outputContentWidth - toolCallGutterWidth(resolvedFontSize)
        : undefined,
      resolvedFontSize
    );
    const structuredPatch = data.path
      ? getDisplayStructuredPatch(
          data.path,
          data.structuredPatch,
          workspaceSnapshot
        )
      : data.structuredPatch;
    const beforeContent = data.path
      ? (getSnapshotBeforeContent(data.path, workspaceSnapshot) ??
        data.oldContent)
      : data.oldContent;

    if (structuredPatch && structuredPatch.length > 0) {
      const expandedDiff = applyDiffGapExpansionStateWithStats(
        toRdvHunks(structuredPatch),
        beforeContent,
        expandedGaps
      );
      return buildOutputDiffStats(
        getRenderedDiffStats(expandedDiff.hunks, viewType),
        {
          viewType,
          collapsed,
          outputFontSize,
          outputContentWidth,
          hunks: expandedDiff.hunks,
          gapExpansion: expandedDiff.gapExpansion,
          toolHeaderLines,
        }
      );
    }
    if (beforeContent !== undefined && data.newContent !== undefined) {
      const { hunks } = toRdvFromContent(beforeContent, data.newContent);
      const expandedDiff = applyDiffGapExpansionStateWithStats(
        hunks,
        beforeContent,
        expandedGaps
      );
      return buildOutputDiffStats(
        getRenderedDiffStats(expandedDiff.hunks, viewType),
        {
          viewType,
          collapsed,
          outputFontSize,
          outputContentWidth,
          hunks: expandedDiff.hunks,
          gapExpansion: expandedDiff.gapExpansion,
          toolHeaderLines,
        }
      );
    }
    return buildOutputDiffStats(
      { added: 0, removed: 0, runs: [] },
      { viewType, collapsed, outputFontSize }
    );
  }

  if (event.type === CLI_EVENT_TYPES.FILE_WRITE) {
    const content = (event.data as { content?: string }).content;
    if (!content) {
      return buildOutputDiffStats(
        { added: 0, removed: 0, runs: [] },
        { viewType, collapsed, outputFontSize, layoutMode: "standalone" }
      );
    }
    // Represent as a single added "row" — the file-write output shows one indicator
    // line, not a full diff view. Using the raw line count here inflates the run
    // count without adding any colored area in the minimap.
    return buildOutputDiffStats(
      {
        added: 1,
        removed: 0,
        runs: [{ count: 1, addedLines: 1, removedLines: 0 }],
      },
      { viewType, collapsed, outputFontSize, layoutMode: "standalone" }
    );
  }

  if (event.type === CLI_EVENT_TYPES.FILE_DELETE) {
    return buildOutputDiffStats(
      {
        added: 0,
        removed: 1,
        runs: [{ count: 1, addedLines: 0, removedLines: 1 }],
      },
      { viewType, collapsed, outputFontSize, layoutMode: "standalone" }
    );
  }

  return buildOutputDiffStats(
    { added: 0, removed: 0, runs: [] },
    { viewType, collapsed, outputFontSize }
  );
}

export function getOutputDiffKey(
  target: OutputMessageTarget,
  stepIndex: number,
  runIndex: number,
  attemptIndex: number,
  eventIndex: number
): string {
  return `${buildDiffAnchorPrefix(
    target.kind === FINAL_STEP_PHASES.FINAL_STEP ? "fp" : "q",
    stepIndex,
    runIndex,
    attemptIndex
  )}-e${eventIndex}`;
}

export function getCliTextForCopy(output: CliOutputType): string | undefined {
  return extractCliOutputText(output);
}

export function applyDiffGapExpansionState(
  baseHunks: readonly HunkData[],
  oldContent: string | undefined,
  expandedGaps?: DiffGapExpansionState
): HunkData[] {
  return applyDiffGapExpansionStateWithStats(
    baseHunks,
    oldContent,
    expandedGaps
  ).hunks;
}

function applyDiffGapExpansionStateWithStats(
  baseHunks: readonly HunkData[],
  oldContent: string | undefined,
  expandedGaps?: DiffGapExpansionState
): AppliedDiffGapExpansionResult {
  const requestedGaps = expandedGaps?.size ?? 0;

  if (baseHunks.length === 0) {
    return {
      hunks: [],
      gapExpansion: {
        model: requestedGaps > 0 ? "base-only-missing-old-content" : "none",
        requestedGaps,
        appliedGaps: 0,
      },
    };
  }

  const initialHunks = [...baseHunks];
  if (expandedGaps == null || expandedGaps.size === 0) {
    return {
      hunks: initialHunks,
      gapExpansion: {
        model: "none",
        requestedGaps: 0,
        appliedGaps: 0,
      },
    };
  }

  if (oldContent === undefined) {
    return {
      hunks: initialHunks,
      gapExpansion: {
        model: "base-only-missing-old-content",
        requestedGaps,
        appliedGaps: 0,
      },
    };
  }

  const oldLineCount = oldContent.split("\n").length;
  let appliedGaps = 0;

  const hunks = [...expandedGaps.entries()]
    .sort(([leftGapIndex], [rightGapIndex]) => leftGapIndex - rightGapIndex)
    .reduce((expandedHunks, [gapIndex, expandedToLine]) => {
      if (gapIndex <= 0 || gapIndex >= baseHunks.length) {
        return expandedHunks;
      }

      const previousHunk = baseHunks[gapIndex - 1];
      const nextHunk = baseHunks[gapIndex];
      if (!previousHunk || !nextHunk) {
        return expandedHunks;
      }

      const gapStart = previousHunk.oldStart + previousHunk.oldLines;
      const gapEnd = nextHunk.oldStart;
      if (gapStart > oldLineCount || expandedToLine <= gapStart) {
        return expandedHunks;
      }

      appliedGaps++;
      return expandFromRawCode(
        expandedHunks,
        oldContent,
        gapStart,
        Math.min(expandedToLine, gapEnd)
      );
    }, initialHunks);

  return {
    hunks,
    gapExpansion: {
      model: "exact",
      requestedGaps,
      appliedGaps,
    },
  };
}

export function buildUndoRecordKey(target: OutputMessageTarget): string {
  return target.kind === FINAL_STEP_PHASES.FINAL_STEP
    ? `finalStep-${target.index}`
    : `queue-${target.index}`;
}
