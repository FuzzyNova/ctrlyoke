import { useMemo } from "react";
import {
  EDITOR_TARGET_KINDS,
  EXECUTION_STATES,
  FINAL_STEP_PHASES,
  HEADLESS_STEER_DELIVERIES,
  getHarnessDisplayName,
  STEP_TYPES,
} from "@root/types/DashboardConstants";
import {
  useActiveSteerTarget,
  type ActiveSteerTarget,
} from "@hooks/useActiveSteerTarget";
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
const NO_INTERRUPTIBLE_HEADLESS_TURN =
  "No live headless turn supports interruption";
const STEER_PROMPT_ONLY = "Steering is only available for prompt steps";
const NEW_WORKFLOW_TITLE =
  "Starts a separate workflow with default settings and this prompt";

function getSteerEnabledTitle(
  target: ActiveSteerTarget,
  stepNumber: number
): string {
  if (target.steerDelivery === HEADLESS_STEER_DELIVERIES.INJECT) {
    const harnessLabel = target.harnessId
      ? getHarnessDisplayName(target.harnessId)
      : "harness";
    return `Sends to the live ${harnessLabel} session (step ${stepNumber}). Prompt overrides are ignored.`;
  }
  if (target.steerDelivery === HEADLESS_STEER_DELIVERIES.QUEUE) {
    const harnessLabel = target.harnessId
      ? getHarnessDisplayName(target.harnessId)
      : "harness";
    return `Queues for the live ${harnessLabel} session after its current turn (step ${stepNumber}). Prompt overrides are ignored.`;
  }

  const harnessLabel = target.harnessId
    ? getHarnessDisplayName(target.harnessId)
    : "harness";
  return `Sends to the live ${harnessLabel} session (step ${stepNumber}). Prompt overrides are ignored.`;
}

function getInterruptTurnTitle(
  target: ActiveSteerTarget,
  stepNumber: number
): string {
  const harnessLabel = target.harnessId
    ? getHarnessDisplayName(target.harnessId)
    : "harness";
  return `Interrupts the current turn on the live ${harnessLabel} headless session (step ${stepNumber}) without stopping the session.`;
}

export interface RunDispatchTarget {
  enabled: boolean;
  disabledReason?: string;
  title: string;
}

export interface RunDispatchTargets {
  parallel: RunDispatchTarget;
  newWorkflow: RunDispatchTarget;
  steer: RunDispatchTarget;
  interruptTurn: RunDispatchTarget;
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
  const activeSteerTarget = useActiveSteerTarget(workflowId);
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
    const steerDisabledReason = !activeSteerTarget
      ? NO_LIVE_HARNESS
      : !isNewPrompt
        ? NOT_NEW_PROMPT
        : stepType !== STEP_TYPES.PROMPT
          ? STEER_PROMPT_ONLY
          : contentReason;
    const interruptTurnDisabledReason = isExternallyManaged
      ? EXTERNAL_RUN
      : !activeSteerTarget?.canInterruptTurn
        ? NO_INTERRUPTIBLE_HEADLESS_TURN
        : undefined;

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
      (activeSteerTarget?.stepIndex ?? runningStepIndex) + 1;
    const steerEnabledTitle = activeSteerTarget
      ? getSteerEnabledTitle(activeSteerTarget, steerStepNumber)
      : NO_LIVE_HARNESS;
    const interruptTurnEnabledTitle = activeSteerTarget?.canInterruptTurn
      ? getInterruptTurnTitle(activeSteerTarget, steerStepNumber)
      : NO_INTERRUPTIBLE_HEADLESS_TURN;

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
      interruptTurn: {
        enabled: interruptTurnDisabledReason === undefined,
        ...(interruptTurnDisabledReason
          ? { disabledReason: interruptTurnDisabledReason }
          : {}),
        title: interruptTurnDisabledReason ?? interruptTurnEnabledTitle,
      },
    };
  }, [
    activeSteerTarget,
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
