import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  mapOrderedHistoryEntriesToMessages,
  type OutputMessage,
} from "@utils/outputProjection";
import { buildOutputRows, type OutputRenderRow } from "@utils/outputRows";
import { measurePhase } from "@utils/performanceProfiler";
import { CLI_EVENT_TYPES } from "@/types/messages";
import type { DiffGapExpansionState } from "@utils/outputRenderUtils";
import {
  DEFAULT_TOOL_CALL_EXPANSION_STATE,
  type ToolCallExpansionSection,
  type ToolCallExpansionState,
} from "@utils/toolCallLayout";
import {
  DEFAULT_BASH_OUTPUT_EXPANSION_STATE,
  type BashOutputExpansionSection,
  type BashOutputExpansionState,
} from "@components/output/BashOutput";
import type { WorkflowStep } from "@store/workflowStore";
import type {
  OrderedHistoryEntry,
  StepOutput,
  UndoRecord,
  WorkflowRunMetadata,
  WorkspaceSnapshot,
} from "@root/types/OutputHistoryTypes";

interface UseOutputRowsModelInput {
  isViewingHistory: boolean;
  historyOutputs: {
    orderedEntries: OrderedHistoryEntry[];
    promptOutputs: Record<number, StepOutput>;
    finalStepOutputs?: Record<number, StepOutput>;
    runMetadata: WorkflowRunMetadata;
  } | null;
  liveOrderedEntries: OrderedHistoryEntry[];
  steps: WorkflowStep[];
  finalStep: WorkflowStep | null;
  streamingChunks: Record<number, string>;
  finalStepStreamingChunks: Record<number, string>;
  isExecutionActive: boolean;
  workspaceSnapshots: Record<number, WorkspaceSnapshot>;
  finalStepWorkspaceSnapshots: Record<number, WorkspaceSnapshot>;
  undoRecords: Record<string, UndoRecord>;
  diffsCollapsed: boolean;
  diffResetVersion: number;
  outputDiffViewType: "split" | "unified";
  outputFontSize: number;
  outputContentWidth: number;
  /** Drops the cached measured height for a row and re-measures it. */
  invalidateMeasuredRow: (rowKey: string) => void;
  /** Like invalidateMeasuredRow, but also re-anchors the viewport to the row
   *  the user just resized so expand/collapse doesn't jump the scroll position. */
  invalidateMeasuredRowForUserResize: (rowKey: string) => void;
  /** Called when the diff reset version changes — gives the owner a chance to
   *  flush row-height caches before the collapse-state change propagates. */
  onDiffViewReset: () => void;
}

/**
 * Owns the projection from live/history entries to chronologically sorted
 * `OutputMessage[]`, the `buildOutputRows` orchestration, and the diff/tool/bash
 * expansion maps that feed it. Measurement and virtualization stay owned by the
 * caller (see OUTPUT_SECTION_REFACTOR_PLAN.md Prompt 8); this hook only calls
 * the invalidation callbacks it is given.
 */
export function useOutputRowsModel({
  isViewingHistory,
  historyOutputs,
  liveOrderedEntries,
  steps,
  finalStep,
  streamingChunks,
  finalStepStreamingChunks,
  isExecutionActive,
  workspaceSnapshots,
  finalStepWorkspaceSnapshots,
  undoRecords,
  diffsCollapsed,
  diffResetVersion,
  outputDiffViewType,
  outputFontSize,
  outputContentWidth,
  invalidateMeasuredRow,
  invalidateMeasuredRowForUserResize,
  onDiffViewReset,
}: UseOutputRowsModelInput) {
  const [diffCollapseState, setDiffCollapseState] = useState<
    Map<string, boolean>
  >(new Map());
  const [diffExpansionState, setDiffExpansionState] = useState<
    Map<string, DiffGapExpansionState>
  >(new Map());
  const [toolCallExpansionState, setToolCallExpansionState] = useState<
    Map<string, ToolCallExpansionState>
  >(new Map());
  const [bashExpansionState, setBashExpansionState] = useState<
    Map<string, BashOutputExpansionState>
  >(new Map());

  // Build chronologically sorted list of all messages from the single ordered entries array.
  const allMessages = useMemo((): OutputMessage[] => {
    if (isViewingHistory && historyOutputs) {
      return mapOrderedHistoryEntriesToMessages(historyOutputs.orderedEntries);
    }
    return mapOrderedHistoryEntriesToMessages(liveOrderedEntries);
  }, [isViewingHistory, historyOutputs, liveOrderedEntries]);

  const {
    rows,
    uniqueStepTargets,
    stepOutputsMap,
    lastCliIndexPerStep,
    firstRowIndexByTarget,
  } = useMemo(
    () =>
      measurePhase(
        "buildOutputRows",
        {
          messages: allMessages.length,
          steps: steps.length,
          history: isViewingHistory,
          outputContentWidth,
          outputFontSize,
        },
        () =>
          buildOutputRows({
            allMessages,
            steps,
            finalStep,
            streamingChunks,
            finalStepStreamingChunks,
            isExecutionActive,
            allowUndoActions: isViewingHistory || !isExecutionActive,
            isViewingHistory,
            historyOutputs,
            workspaceSnapshots,
            finalStepWorkspaceSnapshots,
            undoRecords,
            diffCollapseState,
            diffExpansionState,
            toolCallExpansionState,
            bashExpansionState,
            defaultDiffCollapsed: diffsCollapsed,
            diffViewType: outputDiffViewType,
            outputFontSize,
            outputContentWidth,
          })
      ),
    [
      allMessages,
      steps,
      finalStep,
      streamingChunks,
      finalStepStreamingChunks,
      isExecutionActive,
      isViewingHistory,
      historyOutputs,
      workspaceSnapshots,
      finalStepWorkspaceSnapshots,
      undoRecords,
      diffCollapseState,
      diffExpansionState,
      toolCallExpansionState,
      bashExpansionState,
      diffsCollapsed,
      outputDiffViewType,
      outputFontSize,
      outputContentWidth,
    ]
  );

  const hasDiffRows = useMemo(
    () =>
      rows.some(
        (row) => row.rowKind === "structured-event" && row.diff !== undefined
      ),
    [rows]
  );

  const anyDiffCollapsed = useMemo(
    () =>
      hasDiffRows &&
      rows.some(
        (row) =>
          row.rowKind === "structured-event" && row.diff?.isCollapsed === true
      ),
    [hasDiffRows, rows]
  );

  // Drop expansion-state entries for rows that no longer exist, and seed newly
  // appearing diffs with the current default-collapsed setting.
  useEffect(() => {
    const diffKeys = new Set(
      rows.flatMap((row) =>
        row.rowKind === "structured-event" && row.diff ? [row.diff.key] : []
      )
    );
    const toolCallRowKeys = new Set(
      rows.flatMap((row) =>
        row.rowKind === "structured-event" && row.toolCall ? [row.key] : []
      )
    );
    const bashRowKeys = new Set(
      rows.flatMap((row) =>
        row.rowKind === "structured-event" &&
        row.event.type === CLI_EVENT_TYPES.BASH_COMMAND
          ? [row.key]
          : []
      )
    );

    setDiffCollapseState((previous) => {
      let changed = false;
      const next = new Map(previous);

      for (const key of [...next.keys()]) {
        if (!diffKeys.has(key)) {
          next.delete(key);
          changed = true;
        }
      }

      for (const key of diffKeys) {
        if (!next.has(key)) {
          next.set(key, diffsCollapsed);
          changed = true;
        }
      }

      return changed ? next : previous;
    });
    setDiffExpansionState((previous) => {
      let changed = false;
      const next = new Map(previous);

      for (const key of [...next.keys()]) {
        if (!diffKeys.has(key)) {
          next.delete(key);
          changed = true;
        }
      }

      return changed ? next : previous;
    });
    setToolCallExpansionState((previous) => {
      let changed = false;
      const next = new Map(previous);

      for (const key of [...next.keys()]) {
        if (!toolCallRowKeys.has(key)) {
          next.delete(key);
          changed = true;
        }
      }

      return changed ? next : previous;
    });
    setBashExpansionState((previous) => {
      let changed = false;
      const next = new Map(previous);

      for (const key of [...next.keys()]) {
        if (!bashRowKeys.has(key)) {
          next.delete(key);
          changed = true;
        }
      }

      return changed ? next : previous;
    });
  }, [rows, diffsCollapsed]);

  const previousDiffResetVersion = useRef(diffResetVersion);
  useEffect(() => {
    if (previousDiffResetVersion.current === diffResetVersion) {
      return;
    }
    previousDiffResetVersion.current = diffResetVersion;

    // Diff row heights change dramatically between expanded and collapsed states.
    // Stale measured heights from the previous state would misalign minimap
    // positions, so flush the cache before the collapse-state change propagates.
    onDiffViewReset();
    setDiffExpansionState((previous) =>
      previous.size === 0 ? previous : new Map()
    );

    setDiffCollapseState((previous) => {
      if (previous.size === 0) return previous;
      const next = new Map(previous);
      for (const key of next.keys()) {
        next.set(key, diffsCollapsed);
      }
      return next;
    });
  }, [diffResetVersion, diffsCollapsed, onDiffViewReset]);

  const handleDiffCollapsedChange = useCallback(
    (rowKey: string, diffKey: string, collapsed: boolean) => {
      invalidateMeasuredRow(rowKey);
      if (collapsed) {
        setDiffExpansionState((previous) => {
          if (!previous.has(diffKey)) return previous;
          const next = new Map(previous);
          next.delete(diffKey);
          return next;
        });
      }
      setDiffCollapseState((previous) => {
        const next = new Map(previous);
        next.set(diffKey, collapsed);
        return next;
      });
    },
    [invalidateMeasuredRow]
  );

  const handleDiffGapExpand = useCallback(
    (
      rowKey: string,
      diffKey: string,
      gapIndex: number,
      nextExpandedToLine: number
    ) => {
      invalidateMeasuredRow(rowKey);
      setDiffExpansionState((previous) => {
        const currentDiffState = previous.get(diffKey);
        if (currentDiffState?.get(gapIndex) === nextExpandedToLine) {
          return previous;
        }

        const next = new Map(previous);
        const nextDiffState = new Map(currentDiffState ?? []);
        nextDiffState.set(gapIndex, nextExpandedToLine);
        next.set(diffKey, nextDiffState);
        return next;
      });
    },
    [invalidateMeasuredRow]
  );

  const handleToolCallExpansionChange = useCallback(
    (rowKey: string, section: ToolCallExpansionSection, expanded: boolean) => {
      invalidateMeasuredRowForUserResize(rowKey);
      setToolCallExpansionState((previous) => {
        const currentState =
          previous.get(rowKey) ?? DEFAULT_TOOL_CALL_EXPANSION_STATE;
        const nextState: ToolCallExpansionState = {
          ...currentState,
          paramsExpanded:
            section === "params" ? expanded : currentState.paramsExpanded,
          outputExpanded:
            section === "output" ? expanded : currentState.outputExpanded,
          errorExpanded:
            section === "error" ? expanded : currentState.errorExpanded,
        };

        const isDefaultState =
          !nextState.paramsExpanded &&
          !nextState.outputExpanded &&
          !nextState.errorExpanded;

        if (
          currentState.paramsExpanded === nextState.paramsExpanded &&
          currentState.outputExpanded === nextState.outputExpanded &&
          currentState.errorExpanded === nextState.errorExpanded
        ) {
          return previous;
        }

        const next = new Map(previous);
        if (isDefaultState) {
          next.delete(rowKey);
        } else {
          next.set(rowKey, nextState);
        }
        return next;
      });
    },
    [invalidateMeasuredRowForUserResize]
  );

  const handleBashExpansionChange = useCallback(
    (
      rowKey: string,
      section: BashOutputExpansionSection,
      expanded: boolean
    ) => {
      invalidateMeasuredRowForUserResize(rowKey);
      setBashExpansionState((previous) => {
        const currentState =
          previous.get(rowKey) ?? DEFAULT_BASH_OUTPUT_EXPANSION_STATE;
        const nextState: BashOutputExpansionState = {
          ...currentState,
          commandExpanded:
            section === "command" ? expanded : currentState.commandExpanded,
          outputExpanded:
            section === "output" ? expanded : currentState.outputExpanded,
          errorExpanded:
            section === "error" ? expanded : currentState.errorExpanded,
        };

        const isDefaultState =
          !nextState.commandExpanded &&
          !nextState.outputExpanded &&
          !nextState.errorExpanded;

        if (
          currentState.commandExpanded === nextState.commandExpanded &&
          currentState.outputExpanded === nextState.outputExpanded &&
          currentState.errorExpanded === nextState.errorExpanded
        ) {
          return previous;
        }

        const next = new Map(previous);
        if (isDefaultState) {
          next.delete(rowKey);
        } else {
          next.set(rowKey, nextState);
        }
        return next;
      });
    },
    [invalidateMeasuredRowForUserResize]
  );

  return {
    allMessages,
    rows,
    uniqueStepTargets,
    stepOutputsMap,
    lastCliIndexPerStep,
    firstRowIndexByTarget,
    anyDiffCollapsed,
    bashExpansionState,
    handleDiffCollapsedChange,
    handleDiffGapExpand,
    handleToolCallExpansionChange,
    handleBashExpansionChange,
  };
}

export type { OutputRenderRow };
