import { useMemo } from "react";
import {
  EDITOR_TARGET_KINDS,
  EXECUTION_STATES,
  FINAL_STEP_PHASES,
} from "@root/types/DashboardConstants";
import { useSteerTargets } from "@hooks/useSteerTargets";
import {
  NO_LIVE_HARNESS,
  STEER_EXTERNAL_RUN,
  STEER_NO_CONTENT,
  STEER_NOT_NEW_PROMPT,
  formatSteerTargetLabel,
  formatSteerTargetTitle,
  getSteerDraftDisabledReason,
} from "@utils/steerTargets";
import { useEditorStore } from "@store/editorStore";
import { useSettingsStore } from "@store/settingsStore";
import { useUiStore } from "@store/uiStore";
import { useWorkflowStore } from "@store/workflowStore";
import { getStepDraftContent } from "@utils/stepDraftContent";

const NO_STEP_RUNNING = "No step is running";
const FINAL_STEP_UNSUPPORTED = "The final step can't run in parallel";
const WIDTH_ONE = "Parallel width is 1 — raise `queue.maxParallelSteps`";
const WORKFLOW_PAUSING = "Workflow is pausing";
const NEW_WORKFLOW_TITLE =
  "Starts a separate workflow with default settings and this prompt";
const SEND_STEER_LABEL = "Send Steer Message";

export interface RunDispatchTarget {
  enabled: boolean;
  disabledReason?: string;
  title: string;
}

/** One steer item in the Run menu. */
export interface SteerDispatchTarget extends RunDispatchTarget {
  label: string;
  /** Destination session; absent only for the disabled no-destination item. */
  sessionId?: string;
}

export interface RunDispatchTargets {
  parallel: RunDispatchTarget;
  newWorkflow: RunDispatchTarget;
  /**
   * One item when there are zero or one live destinations ("Send Steer
   * Message"), otherwise one item per destination, in selector order.
   */
  steer: SteerDispatchTarget[];
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
  const steerTargets = useSteerTargets(workflowId);
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
      getStepDraftContent(stepType, promptText, scriptCommand).trim().length >
      0;
    const isExternallyManaged = loadedWorkflows.some(
      (workflow) => workflow.id === workflowId && workflow.externalOwner
    );

    const contentReason = !hasContent
      ? STEER_NO_CONTENT
      : isExternallyManaged
        ? STEER_EXTERNAL_RUN
        : undefined;
    const parallelBaseReason = !isNewPrompt
      ? STEER_NOT_NEW_PROMPT
      : contentReason;
    const steerDraftReason = getSteerDraftDisabledReason({
      selectionTarget,
      stepType,
      promptText,
      isExternallyManaged,
    });
    const steer: SteerDispatchTarget[] =
      steerTargets.length === 0
        ? [
            {
              label: SEND_STEER_LABEL,
              enabled: false,
              disabledReason: NO_LIVE_HARNESS,
              title: NO_LIVE_HARNESS,
            },
          ]
        : steerTargets.map((target) => ({
            label:
              steerTargets.length === 1
                ? SEND_STEER_LABEL
                : formatSteerTargetLabel(target),
            sessionId: target.sessionId,
            enabled: steerDraftReason === undefined,
            ...(steerDraftReason ? { disabledReason: steerDraftReason } : {}),
            title: steerDraftReason ?? formatSteerTargetTitle(target),
          }));

    const activeGroup = parallelGroups.find((group) =>
      activeStepIndices.some(
        (index) => index >= group.startIndex && index <= group.endIndex
      )
    );
    const runningStepIndex =
      activeGroup?.startIndex ?? activeStepIndices[0] ?? currentStep;
    const runningStepNumber = runningStepIndex + 1;
    const enabledTitle = `Runs beside step ${runningStepNumber}; prior context resolves from before step ${runningStepNumber}`;

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
      steer,
    };
  }, [
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
    steerTargets,
    stepType,
    workflowId,
  ]);
}
