import { useCallback, useMemo } from "react";
import { useEditorStore } from "@store/editorStore";
import { useSettingsStore } from "@store/settingsStore";
import { useUiStore } from "@store/uiStore";
import { useWorkflowStore } from "@store/workflowStore";
import {
  EXECUTION_STATES,
  FINAL_STEP_PHASES,
  MESSAGE_TYPES,
  STEP_STATUS,
} from "@/types/messages";
import { isScriptStep } from "@root/types/CtrlYokeTypes";
import { buildWorkflowStepEnabledState } from "@utils/stepEnabledToggle";
import { getExternalReadOnlyLabel } from "@utils/externalRunner";
import { sendMessage } from "@messaging/sendMessage";
import { isWorkflowRunning } from "../utils/status";
import { useActiveWorkflowExternalOwner } from "./useActiveWorkflowExternalOwner";
import { useFinalStepContextMenu } from "./useFinalStepContextMenu";
import { useFinalStepLatestOutput } from "./useLatestStepOutput";
import { useIsSystemGeneratedWorkflow } from "./useIsSystemGeneratedWorkflow";
import { useIsViewingDeletedWorkflow } from "./useIsViewingDeletedWorkflow";
import {
  usePasteToEndContextMenu,
  useStepContextMenu,
} from "./useStepContextMenu";

export function useStepListContextMenus() {
  const {
    steps,
    parallelGroups,
    currentStep,
    executionState,
    finalStep,
    finalStepStatus,
    finalStepPhase,
  } = useWorkflowStore();
  const { pendingRewind, setFinalStepFooterExpanded } = useUiStore();
  const { selectFinalStep, selectPrompt } = useEditorStore();
  const { globalSettings } = useSettingsStore();

  const activeExternalOwner = useActiveWorkflowExternalOwner();
  const isExternallyManaged = activeExternalOwner != null;
  const externalReadOnlyLabel = getExternalReadOnlyLabel(activeExternalOwner);
  // The lineage on screen was deleted while being viewed, or is an internal
  // system lineage (e.g. commit message generation) whose properties are
  // overridden by its owning feature on the next run regardless of what's
  // edited here — either way, nothing here has anywhere meaningful to write to.
  const isViewingDeletedWorkflow = useIsViewingDeletedWorkflow();
  const isSystemGeneratedWorkflow = useIsSystemGeneratedWorkflow();
  const isLineageReadOnly =
    isViewingDeletedWorkflow || isSystemGeneratedWorkflow;

  const isRunning = isWorkflowRunning(executionState);
  const isPaused = executionState === EXECUTION_STATES.PAUSED;
  const canChangeStartPosition =
    !isRunning && executionState !== EXECUTION_STATES.CANCELLING;
  const canPasteStep = executionState !== EXECUTION_STATES.CANCELLING;
  const pendingGroups = useMemo(
    () =>
      parallelGroups
        .filter((group) => group.startIndex >= currentStep)
        .map((group) => ({
          id: group.id,
          start: group.startIndex - currentStep,
          end: group.endIndex - currentStep,
          failFast: group.failFast,
        })),
    [currentStep, parallelGroups]
  );

  const stepContextMenu = useStepContextMenu({
    isExternallyManaged,
    externalReadOnlyLabel,
    canChangeStartPosition,
    canPasteStep,
    executionState,
    confirmResetOperations: globalSettings.confirmResetOperations,
    confirmDeleteOperations: globalSettings.confirmDeleteOperations,
    totalSteps: steps.length,
    currentStep,
    pendingRewind: pendingRewind ?? undefined,
    parallelGroups,
    pendingGroups,
  });

  const pasteToEndContextMenu = usePasteToEndContextMenu({
    isExternallyManaged,
    externalReadOnlyLabel,
    canPasteStep,
    executionState,
    totalSteps: steps.length,
  });

  const handleFinalStepSelect = useCallback(() => {
    if (isExternallyManaged || isLineageReadOnly) return;
    if (finalStep) {
      selectFinalStep(finalStep);
    } else {
      setFinalStepFooterExpanded(true);
      selectPrompt({ kind: FINAL_STEP_PHASES.FINAL_STEP }, { prompt: "" });
    }
  }, [
    isExternallyManaged,
    isLineageReadOnly,
    finalStep,
    selectFinalStep,
    setFinalStepFooterExpanded,
    selectPrompt,
  ]);

  const handleToggleFinalStepEnabled = useCallback(() => {
    if (isExternallyManaged || isLineageReadOnly || !finalStep) return;
    const enabling = finalStep.enabled === false;
    sendMessage(MESSAGE_TYPES.UPDATE_FINAL_PROMPT, {
      finalStep: buildWorkflowStepEnabledState(finalStep, enabling),
      ...(enabling ? { clearProperties: ["enabled"] } : {}),
    });
  }, [isExternallyManaged, isLineageReadOnly, finalStep]);

  const finalStepIsReadOnly =
    isExternallyManaged ||
    isLineageReadOnly ||
    (finalStepPhase === FINAL_STEP_PHASES.FINAL_STEP &&
      finalStepStatus === STEP_STATUS.RUNNING);
  const finalStepLatestOutput = useFinalStepLatestOutput();
  const finalStepContextMenu = useFinalStepContextMenu({
    finalStep,
    isReadOnly: finalStepIsReadOnly,
    isDisabled: finalStep?.enabled === false,
    onToggleEnabled: handleToggleFinalStepEnabled,
    latestOutput: finalStepLatestOutput,
    runtimeMeta:
      finalStep && !isScriptStep(finalStep) ? finalStep._runtime : undefined,
    status: finalStepStatus,
    phase: finalStepPhase,
  });

  return {
    isExternallyManaged,
    externalReadOnlyLabel,
    isViewingDeletedWorkflow,
    isSystemGeneratedWorkflow,
    isLineageReadOnly,
    isRunning,
    isPaused,
    canChangeStartPosition,
    canPasteStep,
    pendingGroups,
    stepContextMenu,
    pasteToEndContextMenu,
    handleFinalStepSelect,
    handleToggleFinalStepEnabled,
    finalStepIsReadOnly,
    finalStepLatestOutput,
    finalStepContextMenu,
  };
}
