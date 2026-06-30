import { useState, useCallback } from "react";
import {
  StepContextMenu,
  type StepContextMenuState,
} from "../components/shared/StepContextMenu";
import { ResetConfirmModal } from "../components/shared/ResetConfirmModal";
import { sendMessage } from "./useMessageHandler";
import {
  EXECUTION_STATES,
  MESSAGE_TYPES,
  type ExecutionState,
} from "../types/messages";
import type { WorkflowStep } from "@store/workflowStore";
import {
  buildWorkflowStepEnabledUpdate,
  getWorkflowStepRawText,
  isScriptWorkflowStep,
  readWorkflowStepFromClipboard,
  serializeWorkflowStepText,
  writeClipboardText,
} from "@utils/stepClipboard";
import { useUiStore } from "@store/uiStore";

interface UseStepContextMenuOptions {
  isCLIManaged: boolean;
  canChangeStartPosition: boolean;
  canPasteStep: boolean;
  executionState: ExecutionState;
  confirmResetOperations: boolean;
  totalSteps: number;
  currentStep: number;
}

interface OpenContextMenuParams {
  step: WorkflowStep;
  /** Position in current (post-reorder) step array — used for SET_START_POSITION */
  setPositionTarget: number;
  /** Original absolute index in steps[] — used for DELETE_PROMPT */
  deleteIndex: number;
  isCurrentStep: boolean;
  isExecutionTargetLocked: boolean;
  direction: "rewind" | "forward";
  /** Response/output text to copy; undefined disables the Copy output item */
  outputText?: string;
}

export function useStepContextMenu({
  isCLIManaged,
  canChangeStartPosition,
  canPasteStep,
  executionState,
  confirmResetOperations,
  totalSteps,
  currentStep,
}: UseStepContextMenuOptions) {
  const [contextMenu, setContextMenu] = useState<StepContextMenuState | null>(
    null
  );
  const [setPositionIndex, setSetPositionIndex] = useState<number | null>(null);

  const handleSetStartPosition = useCallback(
    (target: number) => {
      if (!confirmResetOperations) {
        sendMessage(MESSAGE_TYPES.SET_START_POSITION, { toIndex: target });
      } else {
        setSetPositionIndex(target);
      }
    },
    [confirmResetOperations]
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
      }: OpenContextMenuParams
    ) => {
      const copyContentLabel = isScriptWorkflowStep(step)
        ? "Copy Script"
        : "Copy Prompt";
      const stepToggleLabel = step.enabled === false ? "Enable" : "Disable";
      const pasteDisabledTitle = isCLIManaged
        ? "Read-only — workflow is running via ctrlyoke CLI"
        : executionState === EXECUTION_STATES.CANCELLING
          ? "Cannot paste steps while workflow is cancelling"
          : undefined;

      setContextMenu({
        x,
        y,
        items: [
          {
            label: "Copy Step",
            icon: "codicon-copy",
            disabled: false,
            onClick: () => {
              void writeClipboardText(serializeWorkflowStepText(step));
            },
          },
          {
            label: copyContentLabel,
            icon: "codicon-copy",
            disabled: false,
            onClick: () => {
              void writeClipboardText(getWorkflowStepRawText(step));
            },
          },
          {
            label: "Copy Output",
            icon: "codicon-copy",
            disabled: !outputText,
            disabledTitle: "No output to copy",
            onClick: () => {
              if (!outputText) return;
              void writeClipboardText(outputText);
            },
          },
          {
            label: "Paste Step",
            icon: "codicon-clippy",
            disabled: isCLIManaged || !canPasteStep,
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
                  useUiStore
                    .getState()
                    .showToast(
                      "Clipboard does not contain a workflow step",
                      "warning"
                    );
                });
            },
          },
          { type: "divider" },
          {
            label: "Set Start Position",
            icon:
              direction === "rewind"
                ? "codicon-debug-reverse-continue"
                : "codicon-debug-step-over",
            disabled: !canChangeStartPosition || isCurrentStep,
            disabledTitle: isCurrentStep
              ? "Already the current start position"
              : "Cannot change start position while workflow is running",
            onClick: () => handleSetStartPosition(setPositionTarget),
          },
          { type: "divider" },
          {
            label: stepToggleLabel,
            icon:
              step.enabled === false ? "codicon-check" : "codicon-circle-slash",
            disabled: isCLIManaged,
            disabledTitle: "Read-only — workflow is running via ctrlyoke CLI",
            onClick: () => {
              const enabled = step.enabled === false;
              const update = buildWorkflowStepEnabledUpdate(step, enabled);
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
            disabled: isCLIManaged || isExecutionTargetLocked,
            disabledTitle: isCLIManaged
              ? "Read-only — workflow is running via ctrlyoke CLI"
              : "Cannot delete the currently executing step",
            onClick: () =>
              sendMessage(MESSAGE_TYPES.DELETE_PROMPT, { index: deleteIndex }),
          },
        ],
      });
    },
    [
      canChangeStartPosition,
      canPasteStep,
      executionState,
      handleSetStartPosition,
      isCLIManaged,
    ]
  );

  const handleSetPositionConfirm = useCallback(() => {
    if (setPositionIndex === null) return;
    sendMessage(MESSAGE_TYPES.SET_START_POSITION, {
      toIndex: setPositionIndex,
    });
    setSetPositionIndex(null);
  }, [setPositionIndex]);

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

  return {
    openContextMenu,
    handleSetStartPosition,
    contextMenuPortal,
    setPositionModal,
  };
}

// ─── usePasteToEndContextMenu ─────────────────────────────────────────────────

interface UsePasteToEndContextMenuOptions {
  isCLIManaged: boolean;
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
  isCLIManaged,
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

      const pasteDisabledTitle = isCLIManaged
        ? "Read-only — workflow is running via ctrlyoke CLI"
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
            disabled: isCLIManaged || !canPasteStep,
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
                  useUiStore
                    .getState()
                    .showToast(
                      "Clipboard does not contain a workflow step",
                      "warning"
                    );
                });
            },
          },
        ],
      });
    },
    [isCLIManaged, canPasteStep, executionState, totalSteps]
  );

  const pasteToEndMenuPortal = contextMenu ? (
    <StepContextMenu {...contextMenu} onClose={() => setContextMenu(null)} />
  ) : null;

  return { openPasteToEndMenu, pasteToEndMenuPortal };
}
