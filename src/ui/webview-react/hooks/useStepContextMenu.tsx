import { useState, useCallback, useMemo } from "react";
import {
  StepContextMenu,
  type StepContextMenuState,
} from "../components/shared/StepContextMenu";
import { ResetConfirmModal } from "../components/shared/ResetConfirmModal";
import { DeleteConfirmModal } from "../components/shared/DeleteConfirmModal";
import { sendMessage } from "./useMessageHandler";
import {
  EXECUTION_STATES,
  FINAL_STEP_PHASES,
  MESSAGE_TYPES,
  type ExecutionState,
} from "../types/messages";
import { useWorkflowStore, type WorkflowStep } from "@store/workflowStore";
import { useEditorStore } from "@store/editorStore";
import { executionOwnsCurrentStep } from "@utils/status";
import {
  buildWorkflowStepEnabledUpdate,
  readWorkflowStepFromClipboard,
} from "@utils/stepClipboard";
import {
  getStepSessionDetails,
  type StepRuntimeMetaSnapshot,
} from "@utils/stepMetadataClipboard";
import {
  buildReplyToStepMenuItem,
  buildStepCopyMenuItems,
  buildStepOutputFilterMenuItems,
  buildStepGroupingMenuItems,
  isParallelGroupTopologyLocked,
  getPresentOutputTargetKeys,
} from "@utils/stepContextMenuItems";
import type { ParallelGroupDefinition } from "@root/types/CtrlYokeTypes";
import type { ReorderPromptsMessage } from "@root/types/WebviewMessageTypes";
import type { CliOutput } from "@store/workflowStore";
import {
  postRunLifecycleMutation,
  postSetStartPositionMutation,
} from "../utils/workflowMutation";
import {
  USER_FEEDBACK_SEVERITY,
  WORKTREE_POSITION_DIRECTIONS,
  type WorktreePositionDirection,
} from "@root/types/DashboardConstants";
import { useExecutionPreviewStore } from "@store/executionPreviewStore";
import { getExecutionPreviewEditorSnapshot } from "@utils/executionPreview";
import { notifyUser } from "@utils/notifyUser";
import { useUiStore } from "@store/uiStore";
import { workflowViewAddressKey } from "@utils/viewAddress";
import { getTargetKey } from "@utils/outputProjection";
import type { OrderedHistoryEntry } from "@root/types/OutputHistoryTypes";
import {
  getSelectionCapabilities,
  getStepCapabilities,
  getStepCapabilityDisabledReason,
} from "@utils/stepCapabilities";

const SHELL_WORKFLOW_ID = "_shell";
const EMPTY_TARGET_KEYS: readonly string[] = [];
const EMPTY_ORDERED_ENTRIES: readonly OrderedHistoryEntry[] = [];

interface UseStepContextMenuOptions {
  isExternallyManaged: boolean;
  externalReadOnlyLabel?: string;
  canChangeStartPosition: boolean;
  canPasteStep: boolean;
  executionState: ExecutionState;
  confirmResetOperations: boolean;
  confirmDeleteOperations: boolean;
  totalSteps: number;
  currentStep: number;
  pendingRewind?: { fromStepIndex: number };
  parallelGroups?: readonly ParallelGroupDefinition[];
  pendingGroups?: ReorderPromptsMessage["pendingGroups"];
}

interface OpenContextMenuParams {
  step: WorkflowStep;
  /** Position in current (post-reorder) step array — used for SET_START_POSITION */
  setPositionTarget: number;
  /** Original absolute index in steps[] — used for DELETE_PROMPT */
  deleteIndex: number;
  isCurrentStep: boolean;
  isExecutionTargetLocked: boolean;
  direction: WorktreePositionDirection;
  /** Response/output text to copy; undefined disables the Copy output item */
  outputText?: string;
  /** Latest CLI output for this step, used to build the Copy Metadata text (session ID, tokens, cost) */
  latestOutput?: CliOutput | null;
  /** Cached runtime metadata (session ID, elapsed, context window) — used before/without a full CliOutput */
  runtimeMeta?: StepRuntimeMetaSnapshot;
  /** Live context-window telemetry while this step is currently running */
  liveContextWindow?: { used: number; size: number };
}

const lifecycleMessageTarget = {
  postMessage: (message: unknown) => {
    const { type, ...payload } = message as { type: string } & Record<
      string,
      unknown
    >;
    sendMessage(type, payload);
  },
};

/** Pending-slice order (0..pendingCount-1) with two positions swapped. */
function buildAdjacentSwapOrder(
  pendingCount: number,
  fromIndex: number,
  toIndex: number
): number[] {
  const order = Array.from({ length: pendingCount }, (_, i) => i);
  [order[fromIndex], order[toIndex]] = [order[toIndex], order[fromIndex]];
  return order;
}

export function useStepContextMenu({
  isExternallyManaged,
  externalReadOnlyLabel,
  canChangeStartPosition,
  canPasteStep,
  executionState,
  confirmResetOperations,
  confirmDeleteOperations,
  totalSteps,
  currentStep,
  pendingRewind,
  parallelGroups = [],
  pendingGroups = [],
}: UseStepContextMenuOptions) {
  const displayedViewAddress = useUiStore((s) => s.displayedViewAddress);
  const hiddenOutputTargets = useUiStore((s) => s.hiddenOutputTargets);
  const toggleHiddenOutputTarget = useUiStore(
    (s) => s.toggleHiddenOutputTarget
  );
  const soloOutputTargets = useUiStore((s) => s.soloOutputTargets);
  const isViewingHistory = useUiStore((s) => s.isViewingHistory);
  const liveOrderedEntries = useWorkflowStore((s) => s.liveOrderedEntries);
  const historyOutputs = useWorkflowStore((s) => s.historyOutputs);
  const steps = useWorkflowStore((s) => s.steps);
  const finalStepPhase = useWorkflowStore((s) => s.finalStepPhase);
  const outputEntries = isViewingHistory
    ? (historyOutputs?.orderedEntries ?? EMPTY_ORDERED_ENTRIES)
    : liveOrderedEntries;
  const presentOutputTargetKeys = useMemo(
    () => getPresentOutputTargetKeys(outputEntries),
    [outputEntries]
  );
  const outputFilterWorkflowKey = displayedViewAddress
    ? workflowViewAddressKey(displayedViewAddress)
    : SHELL_WORKFLOW_ID;
  const hiddenOutputKeys =
    hiddenOutputTargets[outputFilterWorkflowKey]?.keys ?? EMPTY_TARGET_KEYS;
  const [contextMenu, setContextMenu] = useState<StepContextMenuState | null>(
    null
  );
  const [setPositionIndex, setSetPositionIndex] = useState<number | null>(null);
  const [pendingDeleteIndices, setPendingDeleteIndices] = useState<
    number[] | null
  >(null);

  const handleDeleteSteps = useCallback(
    (indices: number[]) => {
      if (!confirmDeleteOperations) {
        sendMessage(MESSAGE_TYPES.DELETE_PROMPT, { indices });
        if (indices.length > 1) useEditorStore.getState().clearMultiSelection();
        return;
      }
      setPendingDeleteIndices(indices);
    },
    [confirmDeleteOperations]
  );

  const handleSetStartPosition = useCallback(
    (target: number) => {
      if (!confirmResetOperations) {
        postSetStartPositionMutation(lifecycleMessageTarget, {
          type: MESSAGE_TYPES.SET_START_POSITION,
          toIndex: target,
        });
      } else {
        setSetPositionIndex(target);
      }
    },
    [confirmResetOperations]
  );

  // Swaps a pending step with its neighbor. Used by the Move Up/Down menu
  // items — a keyboard/tap-friendly alternative to drag-to-reorder, notably
  // for PromptChipRail which has no drag surface of its own.
  const moveQueueStep = useCallback(
    (pendingIndex: number, targetPendingIndex: number) => {
      const pendingCount = totalSteps - currentStep;
      if (targetPendingIndex < 0 || targetPendingIndex >= pendingCount) return;
      sendMessage(MESSAGE_TYPES.REORDER_PROMPTS, {
        newPendingOrder: buildAdjacentSwapOrder(
          pendingCount,
          pendingIndex,
          targetPendingIndex
        ),
        pendingGroups,
      });
      const editorStore = useEditorStore.getState();
      if (editorStore.selectionTarget.kind === FINAL_STEP_PHASES.QUEUE) {
        editorStore.cancelEdit();
      }
    },
    [currentStep, pendingGroups, totalSteps]
  );

  const openContextMenu = useCallback(
    (
      x: number,
      y: number,
      {
        step,
        setPositionTarget,
        deleteIndex,
        isCurrentStep,
        isExecutionTargetLocked,
        direction,
        outputText,
        latestOutput,
        runtimeMeta,
        liveContextWindow,
      }: OpenContextMenuParams
    ) => {
      const stepToggleLabel = step.enabled === false ? "Enable" : "Disable";
      const capabilityContext = {
        currentStep,
        executionState,
        pendingRewindBoundary: pendingRewind?.fromStepIndex,
        isExternallyManaged,
        isExecutionTargetLocked,
        totalSteps,
        parallelGroups,
      };
      const capabilities = getStepCapabilities(
        step,
        deleteIndex,
        capabilityContext
      );
      const editorSelection = useEditorStore.getState();
      const selectedIndices =
        editorSelection.multiSelection?.indices ??
        (editorSelection.selectionTarget.kind === FINAL_STEP_PHASES.QUEUE
          ? [editorSelection.selectionTarget.index]
          : []);
      const hasQueueSelection = selectedIndices.length > 0;
      const isPressedStepSelected = selectedIndices.includes(deleteIndex);
      const hasMultiSelection = selectedIndices.length > 1;
      const selectedExecutionTargetLocked =
        executionOwnsCurrentStep(executionState, finalStepPhase) &&
        selectedIndices.includes(currentStep);
      const selectionCapabilityContext = {
        ...capabilityContext,
        isExecutionTargetLocked: selectedExecutionTargetLocked,
      };
      const bulkCapabilities = getSelectionCapabilities(
        selectedIndices,
        steps,
        selectionCapabilityContext
      );
      const firstBulkLockedIndex = selectedIndices.find((index) => {
        const selectedStep = steps[index];
        return (
          !selectedStep ||
          !getStepCapabilities(selectedStep, index, selectionCapabilityContext)
            .canDelete
        );
      });
      const bulkDisabledReason =
        firstBulkLockedIndex === undefined
          ? undefined
          : (getStepCapabilityDisabledReason(
              selectionCapabilityContext,
              "delete",
              firstBulkLockedIndex,
              steps[firstBulkLockedIndex]
            ) ?? "Cannot change a completed or running step");
      const bulkDisabledTitle = bulkDisabledReason
        ? /completed|currently executing|preserved step/i.test(
            bulkDisabledReason
          )
          ? `${bulkDisabledReason}. Remove completed or running steps from the selection to enable this action.`
          : bulkDisabledReason
        : undefined;
      const selectionMenuItems = [
        {
          label: "Select All",
          icon: "codicon-check-all",
          disabled: false,
          onClick: () => useEditorStore.getState().selectAllSteps(),
        },
        ...(hasQueueSelection &&
        !(selectedIndices.length === 1 && isPressedStepSelected)
          ? [
              {
                label: "Select to Here",
                icon: "codicon-selection",
                disabled: false,
                onClick: () =>
                  useEditorStore
                    .getState()
                    .extendMultiSelectionByRange(deleteIndex),
              },
            ]
          : []),
        ...(hasQueueSelection && !isPressedStepSelected
          ? [
              {
                label: "Add to Selection",
                icon: "codicon-add",
                disabled: false,
                onClick: () =>
                  useEditorStore.getState().toggleMultiSelection(deleteIndex),
              },
            ]
          : []),
        ...(hasMultiSelection && isPressedStepSelected
          ? [
              {
                label: "Remove from Selection",
                icon: "codicon-remove",
                disabled: false,
                onClick: () =>
                  useEditorStore.getState().toggleMultiSelection(deleteIndex),
              },
            ]
          : []),
        ...(hasMultiSelection
          ? [
              {
                label: "Clear Selection",
                icon: "codicon-clear-all",
                disabled: false,
                onClick: () => useEditorStore.getState().clearMultiSelection(),
              },
            ]
          : []),
      ];
      const pasteDisabledTitle = isExternallyManaged
        ? (externalReadOnlyLabel ?? "Read-only — external workflow")
        : executionState === EXECUTION_STATES.CANCELLING
          ? "Cannot paste steps while workflow is cancelling"
          : undefined;

      // Move Up/Down only applies to the pending queue (direction "forward");
      // done/completed steps (direction "rewind") can't be reordered.
      const pendingIndex = deleteIndex - currentStep;
      const pendingCount = totalSteps - currentStep;
      const queueLockedTitle = isExternallyManaged
        ? (externalReadOnlyLabel ?? "Read-only — external workflow")
        : "Cannot reorder steps while workflow is cancelling";
      // A running step stays pinned at pending position 0 (mirrors the drag
      // pinning in WorkflowStepsPanel/PromptChipRail): it can't move, and
      // nothing else can move into its slot.
      const moveUpBlockedByPin =
        executionOwnsCurrentStep(executionState, finalStepPhase) &&
        pendingIndex - 1 === 0;
      const moveUpDisabled =
        !capabilities.canReorder || pendingIndex <= 0 || moveUpBlockedByPin;
      const moveUpDisabledTitle = !capabilities.canReorder
        ? (getStepCapabilityDisabledReason(
            capabilityContext,
            "reorder",
            deleteIndex,
            step
          ) ?? queueLockedTitle)
        : pendingIndex <= 0
          ? "Already at the top of the queue"
          : moveUpBlockedByPin
            ? "Cannot move above the currently executing step"
            : undefined;
      const moveDownDisabled =
        !capabilities.canReorder || pendingIndex >= pendingCount - 1;
      const moveDownDisabledTitle = !capabilities.canReorder
        ? (getStepCapabilityDisabledReason(
            capabilityContext,
            "reorder",
            deleteIndex,
            step
          ) ?? queueLockedTitle)
        : pendingIndex >= pendingCount - 1
          ? "Already at the bottom of the queue"
          : undefined;
      const targetKey = getTargetKey({
        kind: FINAL_STEP_PHASES.QUEUE,
        index: deleteIndex,
      });
      const allPresentTargetKeys = presentOutputTargetKeys.includes(targetKey)
        ? presentOutputTargetKeys
        : [...presentOutputTargetKeys, targetKey];
      const containingGroup = parallelGroups.find(
        (group) =>
          deleteIndex >= group.startIndex && deleteIndex <= group.endIndex
      );
      const groupingDisabled =
        isExternallyManaged ||
        executionState === EXECUTION_STATES.CANCELLING ||
        (containingGroup
          ? isParallelGroupTopologyLocked(
              containingGroup,
              useWorkflowStore.getState().steps,
              currentStep,
              executionState,
              finalStepPhase
            )
          : false);
      const groupingItems = buildStepGroupingMenuItems({
        stepIndex: deleteIndex,
        currentStep,
        steps: useWorkflowStore.getState().steps,
        parallelGroups,
        executionState,
        finalStepPhase,
        disabled: groupingDisabled,
        disabledTitle: isExternallyManaged
          ? (externalReadOnlyLabel ?? "Read-only — external workflow")
          : groupingDisabled
            ? "Cannot change a settled or executing parallel group"
            : undefined,
        onReorder: (newPendingOrder, nextPendingGroups) =>
          sendMessage(MESSAGE_TYPES.REORDER_PROMPTS, {
            newPendingOrder,
            pendingGroups: nextPendingGroups,
          }),
      });
      setContextMenu({
        x,
        y,
        items: [
          ...selectionMenuItems,
          { type: "divider" },
          ...buildStepCopyMenuItems({
            step,
            slotNumber: deleteIndex + 1,
            outputText,
            latestOutput,
            runtimeMeta,
            liveContextWindow,
          }),
          { type: "divider" },
          buildReplyToStepMenuItem({
            step,
            ...getStepSessionDetails(step, latestOutput, runtimeMeta),
            sourceLabel: `Step ${deleteIndex + 1}`,
          }),
          { type: "divider" },
          ...buildStepOutputFilterMenuItems({
            hidden: hiddenOutputKeys.includes(targetKey),
            onToggle: () =>
              toggleHiddenOutputTarget(outputFilterWorkflowKey, targetKey),
            onSolo: () =>
              soloOutputTargets(
                outputFilterWorkflowKey,
                [targetKey],
                allPresentTargetKeys
              ),
          }),
          {
            label: "Dry Run Step",
            icon: "codicon-telescope",
            disabled: false,
            onClick: () => {
              useExecutionPreviewStore
                .getState()
                .open(
                  { kind: "step", stepIndex: deleteIndex },
                  getExecutionPreviewEditorSnapshot()
                );
            },
          },
          {
            label: "Paste Step",
            icon: "codicon-clippy",
            disabled: isExternallyManaged || !canPasteStep,
            disabledTitle: pasteDisabledTitle,
            onClick: () => {
              void readWorkflowStepFromClipboard()
                .then((clipboardStep) => {
                  sendMessage(MESSAGE_TYPES.INSERT_WORKFLOW_STEP, {
                    afterIndex: deleteIndex,
                    step: clipboardStep,
                  });
                })
                .catch(() => {
                  notifyUser(
                    "Clipboard does not contain a workflow step",
                    USER_FEEDBACK_SEVERITY.WARNING
                  );
                });
            },
          },
          { type: "divider" },
          {
            label: "Set Start Position",
            icon:
              direction === WORKTREE_POSITION_DIRECTIONS.REWIND
                ? "codicon-debug-reverse-continue"
                : "codicon-debug-step-over",
            disabled: !canChangeStartPosition || isCurrentStep,
            disabledTitle: isCurrentStep
              ? "Already the current start position"
              : "Cannot change start position while workflow is running",
            onClick: () => handleSetStartPosition(setPositionTarget),
          },
          ...(pendingRewind?.fromStepIndex === deleteIndex
            ? [
                {
                  label: "Discard Continuation",
                  icon: "codicon-discard",
                  disabled: isExternallyManaged,
                  disabledTitle:
                    externalReadOnlyLabel ?? "Read-only — external workflow",
                  onClick: () =>
                    postRunLifecycleMutation(lifecycleMessageTarget, {
                      type: MESSAGE_TYPES.DISCARD_CONTINUATION,
                    }),
                },
              ]
            : []),
          ...(direction === "forward"
            ? [
                { type: "divider" as const },
                {
                  label: "Move Up",
                  icon: "codicon-arrow-up",
                  disabled: moveUpDisabled,
                  disabledTitle: moveUpDisabledTitle,
                  onClick: () => moveQueueStep(pendingIndex, pendingIndex - 1),
                },
                {
                  label: "Move Down",
                  icon: "codicon-arrow-down",
                  disabled: moveDownDisabled,
                  disabledTitle: moveDownDisabledTitle,
                  onClick: () => moveQueueStep(pendingIndex, pendingIndex + 1),
                },
              ]
            : []),
          ...(groupingItems.length > 0
            ? [{ type: "divider" as const }, ...groupingItems]
            : []),
          { type: "divider" },
          ...(hasMultiSelection && isPressedStepSelected
            ? (() => {
                const disable = selectedIndices.some(
                  (index) => steps[index]?.enabled !== false
                );
                return [
                  {
                    label: `${disable ? "Disable" : "Enable"} ${selectedIndices.length} steps`,
                    icon: disable ? "codicon-circle-slash" : "codicon-check",
                    disabled: !bulkCapabilities.canToggleEnabled,
                    disabledTitle: bulkCapabilities.canToggleEnabled
                      ? undefined
                      : bulkDisabledTitle,
                    onClick: () =>
                      sendMessage(MESSAGE_TYPES.UPDATE_STEPS, {
                        indices: selectedIndices,
                        properties: { enabled: !disable },
                      }),
                  },
                  {
                    label: `Delete ${selectedIndices.length} steps`,
                    icon: "codicon-trash",
                    disabled: !bulkCapabilities.canDelete,
                    disabledTitle: bulkCapabilities.canDelete
                      ? undefined
                      : bulkDisabledTitle,
                    onClick: () => handleDeleteSteps(selectedIndices),
                  },
                ];
              })()
            : [
                {
                  label: stepToggleLabel,
                  icon:
                    step.enabled === false
                      ? "codicon-check"
                      : "codicon-circle-slash",
                  disabled: !capabilities.canToggleEnabled,
                  disabledTitle: capabilities.canToggleEnabled
                    ? undefined
                    : externalReadOnlyLabel && isExternallyManaged
                      ? externalReadOnlyLabel
                      : getStepCapabilityDisabledReason(
                          capabilityContext,
                          "toggle",
                          deleteIndex,
                          step
                        ),
                  onClick: () => {
                    const enabled = step.enabled === false;
                    const update = buildWorkflowStepEnabledUpdate(
                      step,
                      enabled
                    );
                    sendMessage(MESSAGE_TYPES.UPDATE_PROMPT, {
                      index: deleteIndex,
                      text: update.text,
                      properties: update.properties,
                      clearProperties: update.clearProperties,
                      promptName: update.promptName,
                    });
                  },
                },
                {
                  label: "Delete",
                  icon: "codicon-trash",
                  disabled: !capabilities.canDelete,
                  disabledTitle: capabilities.canDelete
                    ? undefined
                    : externalReadOnlyLabel && isExternallyManaged
                      ? externalReadOnlyLabel
                      : getStepCapabilityDisabledReason(
                          capabilityContext,
                          "delete",
                          deleteIndex,
                          step
                        ),
                  onClick: () => handleDeleteSteps([deleteIndex]),
                },
              ]),
        ],
      });
    },
    [
      canChangeStartPosition,
      canPasteStep,
      currentStep,
      executionState,
      finalStepPhase,
      handleDeleteSteps,
      handleSetStartPosition,
      isExternallyManaged,
      externalReadOnlyLabel,
      hiddenOutputKeys,
      moveQueueStep,
      outputFilterWorkflowKey,
      presentOutputTargetKeys,
      pendingRewind?.fromStepIndex,
      soloOutputTargets,
      totalSteps,
      toggleHiddenOutputTarget,
      parallelGroups,
      steps,
    ]
  );

  const handleSetPositionConfirm = useCallback(() => {
    if (setPositionIndex === null) return;
    postSetStartPositionMutation(lifecycleMessageTarget, {
      type: MESSAGE_TYPES.SET_START_POSITION,
      toIndex: setPositionIndex,
    });
    setSetPositionIndex(null);
  }, [setPositionIndex]);

  const handleDeleteConfirm = useCallback(() => {
    if (pendingDeleteIndices === null) return;
    sendMessage(MESSAGE_TYPES.DELETE_PROMPT, { indices: pendingDeleteIndices });
    if (pendingDeleteIndices.length > 1) {
      useEditorStore.getState().clearMultiSelection();
    }
    setPendingDeleteIndices(null);
  }, [pendingDeleteIndices]);

  const handleDeleteSelection = useCallback(() => {
    const selection = useEditorStore.getState();
    const indices =
      selection.multiSelection?.indices ??
      (selection.selectionTarget.kind === FINAL_STEP_PHASES.QUEUE
        ? [selection.selectionTarget.index]
        : []);
    if (indices.length === 0) return;
    const context = {
      currentStep,
      executionState,
      pendingRewindBoundary: pendingRewind?.fromStepIndex,
      isExternallyManaged,
      isExecutionTargetLocked:
        executionOwnsCurrentStep(executionState, finalStepPhase) &&
        indices.includes(currentStep),
      totalSteps,
      parallelGroups,
    };
    if (!getSelectionCapabilities(indices, steps, context).canDelete) return;
    handleDeleteSteps(indices);
  }, [
    currentStep,
    executionState,
    finalStepPhase,
    handleDeleteSteps,
    isExternallyManaged,
    parallelGroups,
    pendingRewind?.fromStepIndex,
    steps,
    totalSteps,
  ]);

  const contextMenuPortal = contextMenu ? (
    <StepContextMenu {...contextMenu} onClose={() => setContextMenu(null)} />
  ) : null;

  const setPositionModal =
    setPositionIndex !== null
      ? (() => {
          const isRewind = setPositionIndex < currentStep;
          const stepN = setPositionIndex + 1;
          const detail = isRewind
            ? stepN > 1
              ? `Steps ${stepN}–${totalSteps} will reset to pending. Steps 1–${stepN - 1} remain completed.`
              : `All ${totalSteps} steps will reset to pending.`
            : `Steps ${currentStep + 1}–${stepN - 1} will be marked as skipped. Steps ${stepN}–${totalSteps} remain pending.`;
          return (
            <ResetConfirmModal
              isOpen={true}
              title="Set Start Position"
              message={`Start workflow from step ${stepN}?`}
              detail={detail}
              confirmLabel="Set Position"
              onConfirm={handleSetPositionConfirm}
              onCancel={() => setSetPositionIndex(null)}
            />
          );
        })()
      : null;

  const deleteModal =
    pendingDeleteIndices !== null ? (
      <DeleteConfirmModal
        isOpen={true}
        title={
          pendingDeleteIndices.length > 1
            ? `Delete ${pendingDeleteIndices.length} steps?`
            : "Delete Prompt"
        }
        message={
          pendingDeleteIndices.length > 1
            ? `Delete ${pendingDeleteIndices.length} steps?`
            : `Are you sure you want to delete prompt ${pendingDeleteIndices[0] + 1}?`
        }
        detail="This action cannot be undone."
        onConfirm={handleDeleteConfirm}
        onCancel={() => setPendingDeleteIndices(null)}
      />
    ) : null;

  return {
    openContextMenu,
    handleDeleteSelection,
    handleSetStartPosition,
    contextMenuPortal,
    setPositionModal,
    deleteModal,
  };
}

// ─── usePasteToEndContextMenu ─────────────────────────────────────────────────

interface UsePasteToEndContextMenuOptions {
  isExternallyManaged: boolean;
  externalReadOnlyLabel?: string;
  canPasteStep: boolean;
  executionState: ExecutionState;
  /** Used to compute afterIndex = totalSteps - 1 (end of queue). */
  totalSteps: number;
}

/**
 * Minimal context menu with a single "Paste Step" item that always inserts at
 * the end of the queue (afterIndex = totalSteps - 1). Designed for right-clicking
 * or long-pressing blank background areas in the step list panels, enabling
 * paste into empty workflows and paste-to-end in existing ones.
 */
export function usePasteToEndContextMenu({
  isExternallyManaged,
  externalReadOnlyLabel,
  canPasteStep,
  executionState,
  totalSteps,
}: UsePasteToEndContextMenuOptions) {
  const [contextMenu, setContextMenu] = useState<StepContextMenuState | null>(
    null
  );

  const openPasteToEndMenu = useCallback(
    (x: number, y: number) => {
      const afterIndex = totalSteps - 1;

      const pasteDisabledTitle = isExternallyManaged
        ? (externalReadOnlyLabel ?? "Read-only — external workflow")
        : executionState === EXECUTION_STATES.CANCELLING
          ? "Cannot paste steps while workflow is cancelling"
          : undefined;

      setContextMenu({
        x,
        y,
        items: [
          {
            label: "Paste Step",
            icon: "codicon-clippy",
            disabled: isExternallyManaged || !canPasteStep,
            disabledTitle: pasteDisabledTitle,
            onClick: () => {
              void readWorkflowStepFromClipboard()
                .then((clipboardStep) => {
                  sendMessage(MESSAGE_TYPES.INSERT_WORKFLOW_STEP, {
                    afterIndex,
                    step: clipboardStep,
                  });
                })
                .catch(() => {
                  notifyUser(
                    "Clipboard does not contain a workflow step",
                    USER_FEEDBACK_SEVERITY.WARNING
                  );
                });
            },
          },
        ],
      });
    },
    [
      isExternallyManaged,
      externalReadOnlyLabel,
      canPasteStep,
      executionState,
      totalSteps,
    ]
  );

  const pasteToEndMenuPortal = contextMenu ? (
    <StepContextMenu {...contextMenu} onClose={() => setContextMenu(null)} />
  ) : null;

  return { openPasteToEndMenu, pasteToEndMenuPortal };
}
