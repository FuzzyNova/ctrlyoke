import type { WorkflowStep } from "../types/FlightPathTypes";

/**
 * Removes webview-only fields before core queue state is persisted.
 *
 * Step status is projected from queue results and per-step _runtime.completedAt;
 * keeping a copied webview status on the prompt itself makes working files
 * disagree with runtime metadata after rewind/start-position changes.
 */
export function stripViewOnlyWorkflowStepFields(
  step: WorkflowStep
): WorkflowStep {
  const {
    status: _status,
    details: _details,
    ...persistableStep
  } = step as WorkflowStep & {
    status?: unknown;
    details?: unknown;
  };
  return persistableStep as WorkflowStep;
}
