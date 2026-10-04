import { FINAL_STEP_PHASES } from "../types/DashboardConstants";
import type { OutputExecutionTarget } from "../types/OutputHistoryTypes";
import { formatFinalPassLabel } from "./FinalStepLabels";

/** Resolves the shared CLI/dashboard label for output associated with a target. */
export function getTargetStreamingStepName(
  target: OutputExecutionTarget,
  stepName?: string
): string {
  return (
    stepName?.trim() ||
    (target.kind === FINAL_STEP_PHASES.QUEUE
      ? `Step ${target.stepIndex + 1}`
      : formatFinalPassLabel(target.loopIndex + 1))
  );
}
