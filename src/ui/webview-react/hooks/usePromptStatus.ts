import { useWorkflowStore, type WorkflowStep } from "@store/workflowStore";
import {
  STEP_STATUS,
  EXECUTION_STATES,
  type StepStatus,
} from "../types/messages";
import { isWorkflowRunning } from "../utils/status";

/**
 * Returns a `getPromptStatus(prompt, index)` helper that derives the display
 * status for a prompt chip/row from live workflow state.
 *
 * Single source of truth shared by WorkflowStepsPanel and PromptChipRail.
 */
export function usePromptStatus() {
  const { currentStep, executionState, steps } = useWorkflowStore();
  const isRunning = isWorkflowRunning(executionState);

  return function getPromptStatus(
    prompt: WorkflowStep | { status?: StepStatus },
    index: number
  ): StepStatus {
    // When running, position wins for current and past steps.
    // This prevents stale RUNNING icons when currentStep advances without
    // an explicit STEP_STATUS_CHANGED being sent (e.g., CLI watch mode).
    if (isRunning) {
      if (index === currentStep) return STEP_STATUS.RUNNING;
      if (index < currentStep) {
        // Preserve a recorded terminal status (failed/cancelled/skipped) for
        // past steps. Only fall back to COMPLETED when no terminal status has
        // been recorded yet — e.g. currentStep advanced before the
        // STEP_STATUS_CHANGED message arrived (CLI watch mode).
        const status = (prompt as any).status as StepStatus | undefined;
        switch (status) {
          case STEP_STATUS.FAILED:
          case STEP_STATUS.CANCELLED:
          case STEP_STATUS.SKIPPED:
          case STEP_STATUS.COMPLETED:
            return status;
          default:
            return STEP_STATUS.COMPLETED;
        }
      }
    }
    // Eagerly reflect terminal states for the current step before the
    // per-step STEP_STATUS_CHANGED message arrives. executionState flips
    // synchronously, but the step-level status update is a separate postMessage
    // that lands in a later render cycle.
    if (
      executionState === EXECUTION_STATES.CANCELLING &&
      index === currentStep
    ) {
      return STEP_STATUS.CANCELLED;
    }
    if (executionState === EXECUTION_STATES.ERROR && index === currentStep) {
      // An in-flight failure advances currentStep past the step that actually
      // failed (see WorkflowStepsPanel's workflowContinuedAfterFailure), and
      // that step's own FAILED status is sent before executionState flips to
      // ERROR. So if the previous step already recorded FAILED, currentStep
      // now points at the next, not-yet-run step — leave it alone instead of
      // painting a second error icon. Only fall back to eagerly marking
      // currentStep FAILED for failures with no per-step status of their own
      // (e.g. a pre-flight harness failure before any step started).
      const previousStep = currentStep > 0 ? steps[currentStep - 1] : undefined;
      if ((previousStep as any)?.status !== STEP_STATUS.FAILED) {
        return STEP_STATUS.FAILED;
      }
    }
    if ((prompt as any).status) return (prompt as any).status as StepStatus;
    if (index < currentStep) return STEP_STATUS.COMPLETED;
    return STEP_STATUS.PENDING;
  };
}
