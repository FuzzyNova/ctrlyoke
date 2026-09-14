import { useMemo } from "react";
import {
  EDITOR_TARGET_KINDS,
  EXECUTION_STATES,
  FINAL_STEP_PHASES,
  HARNESS_INFO,
  STEP_TYPES,
  type HarnessId,
} from "@root/types/DashboardConstants";
import { useActiveInteractiveSession } from "@hooks/useActiveInteractiveSession";
import { useEditorStore } from "@store/editorStore";
import { useSettingsStore } from "@store/settingsStore";
import { useUiStore } from "@store/uiStore";
import { useWorkflowStore } from "@store/workflowStore";

const NO_STEP_RUNNING = "No step is running";
const FINAL_STEP_UNSUPPORTED = "The final step can't run in parallel";
const WIDTH_ONE = "Parallel width is 1 — raise `queue.maxParallelSteps`";
const WORKFLOW_PAUSING = "Workflow is pausing";
const NO_CONTENT = "Enter a prompt first";
const NOT_NEW_PROMPT = "Only available for a new prompt";
const EXTERNAL_RUN = "Read-only — external run";
const NO_LIVE_HARNESS = "No live harness session for this workflow";
const STEER_PROMPT_ONLY = "Steering is only available for prompt steps";
const NEW_WORKFLOW_TITLE =
  "Starts a separate workflow with default settings and this prompt";

export interface RunDispatchTarget {
  enabled: boolean;
  disabledReason?: string;
  title: string;
}

export interface RunDispatchTargets {
  parallel: RunDispatchTarget;
  newWorkflow: RunDispatchTarget;
  steer: RunDispatchTarget;
}

/**
 * Derive prompt-editor destinations from the current workflow and editor
 * state. Keeping this policy here lets EditorFooter remain a presentation
 * component and keeps the destination gates identical for prompt and script
 * drafts.
 */
export function useRunDispatchTargets(
  workflowId: string | null
): RunDispatchTargets {
  const activeInteractiveSession = useActiveInteractiveSession(workflowId);
  const selectionTarget = useEditorStore((state) => state.selectionTarget);
  const promptText = useEditorStore((state) => state.promptText);
  const scriptCommand = useEditorStore((state) => state.scriptCommand);
  const stepType = useEditorStore((state) => state.stepType);
  const executionState = useWorkflowStore((state) => state.executionState);
  const activeStepIndices = useWorkflowStore(
    (state) => state.activeStepIndices
  );
  const currentStep = useWorkflowStore((state) => state.currentStep);
  const finalStepPhase = useWorkflowStore((state) => state.finalStepPhase);
  const parallelGroups = useWorkflowStore((state) => state.parallelGroups);
  const effectiveParallelGroupWidth = useSettingsStore(
    (state) => state.globalSettings.effectiveParallelGroupWidth
  );
  const loadedWorkflows = useUiStore((state) => state.loadedWorkflows);

  return useMemo(() => {
    const isNewPrompt = selectionTarget.kind === EDITOR_TARGET_KINDS.NEW_PROMPT;
    const hasContent =
      stepType === STEP_TYPES.SCRIPT
        ? scriptCommand.trim().length > 0
        : promptText.trim().length > 0;
    const isExternallyManaged = loadedWorkflows.some(
      (workflow) => workflow.id === workflowId && workflow.externalOwner
    );

    const contentReason = !hasContent
      ? NO_CONTENT
      : isExternallyManaged
        ? EXTERNAL_RUN
        : undefined;
    const parallelBaseReason = !isNewPrompt ? NOT_NEW_PROMPT : contentReason;
    const steerDisabledReason = !activeInteractiveSession
      ? NO_LIVE_HARNESS
      : !isNewPrompt
        ? NOT_NEW_PROMPT
        : stepType !== STEP_TYPES.PROMPT
          ? STEER_PROMPT_ONLY
          : contentReason;

    const activeGroup = parallelGroups.find((group) =>
      activeStepIndices.some(
        (index) => index >= group.startIndex && index <= group.endIndex
      )
    );
    const runningStepIndex =
      activeGroup?.startIndex ?? activeStepIndices[0] ?? currentStep;
    const runningStepNumber = runningStepIndex + 1;
    const enabledTitle = `Runs beside step ${runningStepNumber}; prior context resolves from before step ${runningStepNumber}`;
    const steerStepNumber =
      (activeInteractiveSession?.stepIndex ?? runningStepIndex) + 1;
    const harnessLabel = activeInteractiveSession?.harnessId
      ? (HARNESS_INFO[activeInteractiveSession.harnessId as HarnessId]?.name ??
        activeInteractiveSession.harnessId)
      : "harness";
    const steerEnabledTitle = `Sends to the live ${harnessLabel} session (step ${steerStepNumber}). Prompt overrides are ignored.`;

    let parallelDisabledReason = parallelBaseReason;
    if (
      parallelDisabledReason === undefined &&
      executionState === EXECUTION_STATES.PAUSING
    ) {
      parallelDisabledReason = WORKFLOW_PAUSING;
    } else if (
      parallelDisabledReason === undefined &&
      executionState !== EXECUTION_STATES.RUNNING
    ) {
      parallelDisabledReason = NO_STEP_RUNNING;
    } else if (
      parallelDisabledReason === undefined &&
      finalStepPhase === FINAL_STEP_PHASES.FINAL_STEP
    ) {
      parallelDisabledReason = FINAL_STEP_UNSUPPORTED;
    } else if (
      parallelDisabledReason === undefined &&
      activeStepIndices.length === 0
    ) {
      parallelDisabledReason = NO_STEP_RUNNING;
    } else if (
      parallelDisabledReason === undefined &&
      effectiveParallelGroupWidth <= 1
    ) {
      parallelDisabledReason = WIDTH_ONE;
    }

    return {
      parallel: {
        enabled: parallelDisabledReason === undefined,
        ...(parallelDisabledReason
          ? { disabledReason: parallelDisabledReason }
          : {}),
        title: parallelDisabledReason ?? enabledTitle,
      },
      newWorkflow: {
        enabled: contentReason === undefined,
        ...(contentReason ? { disabledReason: contentReason } : {}),
        title: contentReason ?? NEW_WORKFLOW_TITLE,
      },
      steer: {
        enabled: steerDisabledReason === undefined,
        ...(steerDisabledReason ? { disabledReason: steerDisabledReason } : {}),
        title: steerDisabledReason ?? steerEnabledTitle,
      },
    };
  }, [
    activeInteractiveSession,
    activeStepIndices,
    currentStep,
    effectiveParallelGroupWidth,
    executionState,
    finalStepPhase,
    loadedWorkflows,
    parallelGroups,
    promptText,
    scriptCommand,
    selectionTarget,
    stepType,
    workflowId,
  ]);
}
