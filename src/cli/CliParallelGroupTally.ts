import { STEP_STATUS, type StepStatus } from "../types/DashboardConstants";

export interface CliParallelGroupTallyState {
  started: Set<number>;
  completed: Set<number>;
  failed: Set<number>;
}

/** Settles one started member from its queue status; returns whether it moved. */
export function settleCliParallelGroupMember(
  state: CliParallelGroupTallyState,
  stepIndex: number,
  status: StepStatus | undefined
): boolean {
  if (!state.started.has(stepIndex)) return false;

  if (status === STEP_STATUS.FAILED) {
    const changed =
      !state.failed.has(stepIndex) || state.completed.has(stepIndex);
    state.completed.delete(stepIndex);
    state.failed.add(stepIndex);
    return changed;
  }

  if (
    status !== STEP_STATUS.COMPLETED &&
    status !== STEP_STATUS.CANCELLED &&
    status !== STEP_STATUS.SKIPPED &&
    status !== STEP_STATUS.NO_TURN_STARTED
  ) {
    return false;
  }

  const changed =
    !state.completed.has(stepIndex) || state.failed.has(stepIndex);
  state.failed.delete(stepIndex);
  state.completed.add(stepIndex);
  return changed;
}
