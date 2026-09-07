import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  mapOrderedHistoryEntriesToMessages,
  type OutputMessage,
} from "@utils/outputProjection";
import {
  buildOutputRows,
  getCollapsibleAttemptGroupKeys,
} from "@utils/outputRows";
import { getTargetKey } from "@utils/outputProjection";
import { measurePhase } from "@utils/performanceProfiler";
import { CLI_EVENT_TYPES } from "@/types/messages";
import type { DiffGapExpansionState } from "@utils/outputRenderUtils";
import type { HarnessColorSettings } from "@root/types/CtrlYokeSettings";
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
import type { ParallelGroupDefinition } from "@root/types/CtrlYokeTypes";
import type {
  DiffViewType,
  HarnessId,
  StepColorMode,
} from "@root/types/DashboardConstants";
import { useUiStore } from "@store/uiStore";
import { workflowViewAddressKey } from "@utils/viewAddress";
import {
  BASH_OUTPUT_EXPANSION_SECTIONS,
  OUTPUT_ROW_KINDS,
  TOOL_CALL_EXPANSION_SECTIONS,
} from "@root/types/DashboardConstants";
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
    activityEntries?: import("@root/types/OutputHistoryTypes").OutputActivityEntry[];
    promptOutputs: Record<number, StepOutput>;
    finalStepOutputs?: Record<number, StepOutput>;
    runMetadata: WorkflowRunMetadata;
  } | null;
  liveOrderedEntries: OrderedHistoryEntry[];
  liveActivityEntries: import("@root/types/OutputHistoryTypes").OutputActivityEntry[];
  steps: WorkflowStep[];
  finalStep: WorkflowStep | null;
  parallelGroups?: readonly ParallelGroupDefinition[];
  activeStepIndices?: readonly number[];
  effectiveHarness: HarnessId;
  stepColorMode?: StepColorMode;
  harnessColorSettings?: HarnessColorSettings;
  streamingChunks: Record<string, string>;
  finalStepStreamingChunks: Record<string, string>;
  isExecutionActive: boolean;
  allowUndoActions: boolean;
  workspaceSnapshots: Record<number, WorkspaceSnapshot>;
  finalStepWorkspaceSnapshots: Record<number, WorkspaceSnapshot>;
  undoRecords: Record<string, UndoRecord>;
  diffsCollapsed: boolean;
  diffResetVersion: number;
  outputDiffViewType: DiffViewType;
  outputFontSize: number;
  outputContentWidth: number;
  collapsedToolOutputLineCount: number;
  /** Drops the cached measured height for a row and re-measures it. */
  invalidateMeasuredRow: (rowKey: string) => void;
  /** Like invalidateMeasuredRow, but also re-anchors the viewport to the row
   *  the user just resized so expand/collapse doesn't jump the scroll position. */
  invalidateMeasuredRowForUserResize: (rowKey: string) => void;
  /** Called when the diff reset version changes — gives the owner a chance to
   *  flush row-height caches before the collapse-state change propagates. */
  onDiffViewReset: () => void;
}

const SHELL_WORKFLOW_ID = "_shell";

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
  liveActivityEntries,
  steps,
  finalStep,
  parallelGroups,
  activeStepIndices,
  effectiveHarness,
  stepColorMode,
  harnessColorSettings,
  streamingChunks,
  finalStepStreamingChunks,
  isExecutionActive,
  allowUndoActions,
  workspaceSnapshots,
  finalStepWorkspaceSnapshots,
  undoRecords,
  diffsCollapsed,
  diffResetVersion,
  outputDiffViewType,
  outputFontSize,
  outputContentWidth,
  collapsedToolOutputLineCount,
  invalidateMeasuredRow,
  invalidateMeasuredRowForUserResize,
  onDiffViewReset,
}: UseOutputRowsModelInput) {
  const displayedViewAddress = useUiStore(
    (state) => state.displayedViewAddress
  );
  const hiddenOutputTargets = useUiStore((state) => state.hiddenOutputTargets);
  const hiddenOutputAddressKey = useMemo(
    () =>
      displayedViewAddress
        ? workflowViewAddressKey(displayedViewAddress)
        : SHELL_WORKFLOW_ID,
    [displayedViewAddress]
  );
  const hiddenTargetKeys = useMemo(
    () => new Set(hiddenOutputTargets[hiddenOutputAddressKey]?.keys ?? []),
    [hiddenOutputAddressKey, hiddenOutputTargets]
  );
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
  const [scriptVerdictExpansionState, setScriptVerdictExpansionState] =
    useState<Map<string, boolean>>(new Map());
  const [scriptOutputExpansionState, setScriptOutputExpansionState] = useState<
    Map<string, boolean>
  >(new Map());
  const [collapsedAttemptGroupKeys, setCollapsedAttemptGroupKeys] = useState<
    Set<string>
  >(new Set());

  // Build chronologically sorted list of all messages from the single ordered entries array.
  const allMessages = useMemo((): OutputMessage[] => {
    if (isViewingHistory && historyOutputs) {
      return mapOrderedHistoryEntriesToMessages(
        historyOutputs.orderedEntries,
        historyOutputs.activityEntries
      );
    }
    return mapOrderedHistoryEntriesToMessages(
      liveOrderedEntries,
      liveActivityEntries
    );
  }, [
    isViewingHistory,
    historyOutputs,
    liveOrderedEntries,
    liveActivityEntries,
  ]);

  const collapsibleAttemptGroupKeys = useMemo(
    () => getCollapsibleAttemptGroupKeys(allMessages),
    [allMessages]
  );

  useEffect(() => {
    setCollapsedAttemptGroupKeys((previous) => {
      const next = new Set(
        [...previous].filter((key) => collapsibleAttemptGroupKeys.has(key))
      );
      for (const key of collapsibleAttemptGroupKeys) next.add(key);
      if (
        next.size === previous.size &&
        [...next].every((key) => previous.has(key))
      ) {
        return previous;
      }
      return next;
    });
  }, [collapsibleAttemptGroupKeys]);

  const {
    rows,
    uniqueStepTargets,
    stepOutputsMap,
    lastCliIndexPerStep,
    firstRowIndexByTarget,
    anchorRowIndexByTarget,
    latestActivityRowKey,
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
          collapsedToolOutputLineCount,
          hiddenTargets: hiddenTargetKeys.size,
        },
        () =>
          buildOutputRows({
            allMessages,
            steps,
            finalStep,
            parallelGroups,
            activeStepIndices,
            effectiveHarness,
            stepColorMode,
            harnessColorSettings,
            streamingChunks,
            finalStepStreamingChunks,
            isExecutionActive,
            allowUndoActions,
            isViewingHistory,
            historyOutputs,
            workspaceSnapshots,
            finalStepWorkspaceSnapshots,
            undoRecords,
            diffCollapseState,
            diffExpansionState,
            toolCallExpansionState,
            bashExpansionState,
            scriptVerdictExpansionState,
            scriptOutputExpansionState,
            collapsedAttemptGroupKeys,
            hiddenTargetKeys,
            defaultDiffCollapsed: diffsCollapsed,
            diffViewType: outputDiffViewType,
            outputFontSize,
            outputContentWidth,
            collapsedToolOutputLineCount,
          })
      ),
    [
      allMessages,
      steps,
      finalStep,
      parallelGroups,
      activeStepIndices,
      effectiveHarness,
      stepColorMode,
      harnessColorSettings,
      streamingChunks,
      finalStepStreamingChunks,
      isExecutionActive,
      allowUndoActions,
      isViewingHistory,
      historyOutputs,
      workspaceSnapshots,
      finalStepWorkspaceSnapshots,
      undoRecords,
      diffCollapseState,
      diffExpansionState,
      toolCallExpansionState,
      bashExpansionState,
      scriptVerdictExpansionState,
      scriptOutputExpansionState,
      collapsedAttemptGroupKeys,
      hiddenTargetKeys,
      diffsCollapsed,
      outputDiffViewType,
      outputFontSize,
      outputContentWidth,
      collapsedToolOutputLineCount,
    ]
  );

  const hasDiffRows = useMemo(
    () =>
      rows.some(
        (row) =>
          row.rowKind === OUTPUT_ROW_KINDS.STRUCTURED_EVENT &&
          row.diff !== undefined
      ),
    [rows]
  );

  const anyDiffCollapsed = useMemo(
    () =>
      hasDiffRows &&
      rows.some(
        (row) =>
          row.rowKind === OUTPUT_ROW_KINDS.STRUCTURED_EVENT &&
          row.diff?.isCollapsed === true
      ),
    [hasDiffRows, rows]
  );

  // Drop expansion-state entries for rows that no longer exist, and seed newly
  // appearing diffs with the current default-collapsed setting.
  useEffect(() => {
    const presentTargetKeys = new Set(
      uniqueStepTargets.map((target) => getTargetKey(target))
    );
    useUiStore
      .getState()
      .pruneHiddenOutputTargets(hiddenOutputAddressKey, presentTargetKeys);

    const diffKeys = new Set(
      rows.flatMap((row) =>
        row.rowKind === OUTPUT_ROW_KINDS.STRUCTURED_EVENT && row.diff
          ? [row.diff.key]
          : []
      )
    );
    const toolCallRowKeys = new Set(
      rows.flatMap((row) =>
        row.rowKind === OUTPUT_ROW_KINDS.STRUCTURED_EVENT && row.toolCall
          ? [row.key]
          : []
      )
    );
    const bashRowKeys = new Set(
      rows.flatMap((row) =>
        row.rowKind === OUTPUT_ROW_KINDS.STRUCTURED_EVENT &&
        row.event.type === CLI_EVENT_TYPES.BASH_COMMAND
          ? [row.key]
          : []
      )
    );
    const scriptVerdictRowKeys = new Set(
      rows.flatMap((row) =>
        row.rowKind === OUTPUT_ROW_KINDS.SCRIPT_VERDICT ? [row.key] : []
      )
    );
    // Keyed by the toggle, not the row: which slice carries the toggle moves
    // between the collapsed and expanded layouts.
    const scriptOutputToggleKeys = new Set(
      rows.flatMap((row) =>
        row.rowKind === OUTPUT_ROW_KINDS.SCRIPT_OUTPUT && row.tailToggle
          ? [row.tailToggle.key]
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
    setScriptVerdictExpansionState((previous) => {
      let changed = false;
      const next = new Map(previous);

      for (const key of [...next.keys()]) {
        if (!scriptVerdictRowKeys.has(key)) {
          next.delete(key);
          changed = true;
        }
      }

      return changed ? next : previous;
    });
    setScriptOutputExpansionState((previous) => {
      let changed = false;
      const next = new Map(previous);

      for (const key of [...next.keys()]) {
        if (!scriptOutputToggleKeys.has(key)) {
          next.delete(key);
          changed = true;
        }
      }

      return changed ? next : previous;
    });
  }, [
    diffsCollapsed,
    hiddenOutputAddressKey,
    hiddenOutputTargets,
    rows,
    uniqueStepTargets,
  ]);

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
            section === TOOL_CALL_EXPANSION_SECTIONS.PARAMS
              ? expanded
              : currentState.paramsExpanded,
          outputExpanded:
            section === TOOL_CALL_EXPANSION_SECTIONS.OUTPUT
              ? expanded
              : currentState.outputExpanded,
          errorExpanded:
            section === TOOL_CALL_EXPANSION_SECTIONS.ERROR
              ? expanded
              : currentState.errorExpanded,
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
            section === BASH_OUTPUT_EXPANSION_SECTIONS.COMMAND
              ? expanded
              : currentState.commandExpanded,
          outputExpanded:
            section === BASH_OUTPUT_EXPANSION_SECTIONS.OUTPUT
              ? expanded
              : currentState.outputExpanded,
          errorExpanded:
            section === BASH_OUTPUT_EXPANSION_SECTIONS.ERROR
              ? expanded
              : currentState.errorExpanded,
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

  const handleScriptVerdictExpansionChange = useCallback(
    (rowKey: string, expanded: boolean) => {
      invalidateMeasuredRowForUserResize(rowKey);
      setScriptVerdictExpansionState((previous) => {
        if (!expanded) {
          if (!previous.has(rowKey)) return previous;
          const next = new Map(previous);
          next.delete(rowKey);
          return next;
        }
        if (previous.get(rowKey) === true) return previous;
        const next = new Map(previous);
        next.set(rowKey, true);
        return next;
      });
    },
    [invalidateMeasuredRowForUserResize]
  );

  const handleScriptOutputExpansionChange = useCallback(
    (rowKey: string, toggleKey: string, expanded: boolean) => {
      invalidateMeasuredRowForUserResize(rowKey);
      setScriptOutputExpansionState((previous) => {
        if (!expanded) {
          if (!previous.has(toggleKey)) return previous;
          const next = new Map(previous);
          next.delete(toggleKey);
          return next;
        }
        if (previous.get(toggleKey) === true) return previous;
        const next = new Map(previous);
        next.set(toggleKey, true);
        return next;
      });
    },
    [invalidateMeasuredRowForUserResize]
  );

  const handleAttemptGroupToggle = useCallback((groupKey: string) => {
    setCollapsedAttemptGroupKeys((previous) => {
      const next = new Set(previous);
      if (next.has(groupKey)) {
        next.delete(groupKey);
      } else {
        next.add(groupKey);
      }
      return next;
    });
  }, []);

  return {
    allMessages,
    rows,
    uniqueStepTargets,
    stepOutputsMap,
    lastCliIndexPerStep,
    firstRowIndexByTarget,
    anchorRowIndexByTarget,
    latestActivityRowKey,
    anyDiffCollapsed,
    bashExpansionState,
    handleScriptVerdictExpansionChange,
    handleScriptOutputExpansionChange,
    handleAttemptGroupToggle,
    handleDiffCollapsedChange,
    handleDiffGapExpand,
    handleToolCallExpansionChange,
    handleBashExpansionChange,
  };
}
