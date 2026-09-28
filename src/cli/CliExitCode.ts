import {
  EXECUTION_STATES,
  FAILURE_KINDS,
  STEP_STATUS,
} from "../types/DashboardConstants";
import type { QueueState } from "../types/CtrlYokeTypes";

/** Determine the CLI process exit code from the final workflow state. */
export function getExitCode(
  state: Pick<QueueState, "status" | "results">
): number {
  if (state.status === EXECUTION_STATES.COMPLETED) {
    return 0;
  }

  if (state.status === EXECUTION_STATES.ERROR) {
    const failureKind = state.results?.find(
      (result) => result.status === STEP_STATUS.FAILED
    )?.failureKind;

    if (failureKind === FAILURE_KINDS.TIMEOUT) {
      return 4;
    }

    if (failureKind === FAILURE_KINDS.HARNESS_NOT_INSTALLED) {
      return 3;
    }
  }

  return 1;
}
