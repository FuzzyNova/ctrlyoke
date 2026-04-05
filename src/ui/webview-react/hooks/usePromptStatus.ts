import { useWorkflowStore, type WorkflowStep } from "@store/workflowStore";
import { STEP_STATUS, EXECUTION_STATES, type StepStatus } from "../types/messages";

/**
 * Returns a `getPromptStatus(prompt, index)` helper that derives the display
 * status for a prompt chip/row from live workflow state.
 *
 * Single source of truth shared by WorkflowStepsPanel and MobilePromptsSidebar.
 */
export function usePromptStatus() {
  const { currentStep, executionState } = useWorkflowStore();
  const isRunning = executionState === EXECUTION_STATES.RUNNING;

  return function getPromptStatus(
    prompt: WorkflowStep | { status?: StepStatus },
    index: number
  ): StepStatus {
    // When running, position wins for current and past steps.
    // This prevents stale RUNNING icons when currentStep advances without
    // an explicit STEP_STATUS_CHANGED being sent (e.g., CLI watch mode).
    if (isRunning) {
      if (index === currentStep) return STEP_STATUS.RUNNING;
      if (index < currentStep) return STEP_STATUS.COMPLETED;
    }
    // Eagerly reflect terminal states for the current step before the
    // per-step STEP_STATUS_CHANGED message arrives. executionState flips
    // synchronously, but the step-level status update is a separate postMessage
    // that lands in a later render cycle.
    if (executionState === EXECUTION_STATES.CANCELLING && index === currentStep) {
      return STEP_STATUS.CANCELLED;
    }
    if (executionState === EXECUTION_STATES.ERROR && index === currentStep) {
      return STEP_STATUS.FAILED;
    }
    if ((prompt as any).status) return (prompt as any).status as StepStatus;
    if (index < currentStep) return STEP_STATUS.COMPLETED;
    return STEP_STATUS.PENDING;
  };
}
