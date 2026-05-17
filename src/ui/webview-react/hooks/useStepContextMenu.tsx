import { useState, useCallback } from "react";
import {
  StepContextMenu,
  type StepContextMenuState,
} from "../components/shared/StepContextMenu";
import { ResetConfirmModal } from "../components/shared/ResetConfirmModal";
import { sendMessage } from "./useMessageHandler";
import { MESSAGE_TYPES, STEP_STATUS, type StepStatus } from "../types/messages";

interface UseStepContextMenuOptions {
  isCLIManaged: boolean;
  canChangeStartPosition: boolean;
  confirmResetOperations: boolean;
  totalSteps: number;
  currentStep: number;
}

interface OpenContextMenuParams {
  /** Position in current (post-reorder) step array — used for SET_START_POSITION */
  setPositionTarget: number;
  /** Original absolute index in steps[] — used for DELETE_PROMPT */
  deleteIndex: number;
  isCurrentStep: boolean;
  direction: "rewind" | "forward";
  status: StepStatus;
  /** Response/output text to copy; undefined disables the Copy output item */
  outputText?: string;
}

export function useStepContextMenu({
  isCLIManaged,
  canChangeStartPosition,
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
        setPositionTarget,
        deleteIndex,
        isCurrentStep,
        direction,
        status,
        outputText,
      }: OpenContextMenuParams
    ) => {
      setContextMenu({
        x,
        y,
        items: [
          {
            label: "Set start position",
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
          {
            label: "Copy output",
            icon: "codicon-copy",
            disabled: !outputText,
            disabledTitle: "No output to copy",
            onClick: () => {
              if (!outputText) return;
              if (navigator.clipboard?.writeText) {
                void navigator.clipboard.writeText(outputText);
              } else {
                const textArea = document.createElement("textarea");
                textArea.value = outputText;
                textArea.style.position = "fixed";
                textArea.style.left = "-9999px";
                document.body.appendChild(textArea);
                textArea.select();
                document.execCommand("copy");
                document.body.removeChild(textArea);
              }
            },
          },
          {
            label: "Delete",
            icon: "codicon-trash",
            disabled: isCLIManaged || status === STEP_STATUS.RUNNING,
            disabledTitle: isCLIManaged
              ? "Read-only — workflow is running via FlightPath CLI"
              : "Cannot delete a prompt that is currently running",
            onClick: () =>
              sendMessage(MESSAGE_TYPES.DELETE_PROMPT, { index: deleteIndex }),
          },
        ],
      });
    },
    [canChangeStartPosition, isCLIManaged, handleSetStartPosition]
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
