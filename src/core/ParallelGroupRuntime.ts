import type {
  ParallelGroupDefinition,
  WorkflowStep,
} from "../types/CtrlYokeTypes";
import { hasStarted } from "../utils/StepStatusDerivation";

/**
 * Whether the queue target for a live join still has executing work.
 * Parallel groups keep the queue index at their anchor until the group joins,
 * so any unsettled started member keeps the group eligible for a join.
 */
export function isActiveQueueWorkRunning(
  steps: readonly WorkflowStep[],
  currentIndex: number,
  group?: ParallelGroupDefinition
): boolean {
  const isRunning = (step: WorkflowStep | undefined): boolean =>
    hasStarted(step) && step?._runtime?.completedAt === undefined;

  if (group) {
    for (let index = group.startIndex; index <= group.endIndex; index += 1) {
      if (isRunning(steps[index])) return true;
    }
    return false;
  }

  return isRunning(steps[currentIndex]);
}
