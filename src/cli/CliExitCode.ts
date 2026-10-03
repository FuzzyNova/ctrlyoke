import {
  EXECUTION_STATES,
  FAILURE_KINDS,
  FINAL_STEP_PHASES,
  STEP_STATUS,
} from "../types/DashboardConstants";
import type {
  FinalStepRuntimeState,
  PromptResult,
  QueueState,
} from "../types/CtrlYokeTypes";

export type TerminalFailure =
  | { kind: "queue"; index: number; result: PromptResult }
  | {
      kind: typeof FINAL_STEP_PHASES.FINAL_STEP;
      runtime: FinalStepRuntimeState;
    };

/** Select the failed step that made an errored workflow stop. */
export function selectTerminalFailure(
  state: Pick<QueueState, "status" | "results">,
  finalStepRuntime?: FinalStepRuntimeState
): TerminalFailure | undefined {
  if (state.status === EXECUTION_STATES.COMPLETED) {
    return undefined;
  }

  if (
    state.status === EXECUTION_STATES.ERROR &&
    finalStepRuntime?.status === STEP_STATUS.FAILED
  ) {
    return { kind: FINAL_STEP_PHASES.FINAL_STEP, runtime: finalStepRuntime };
  }

  for (let index = (state.results?.length ?? 0) - 1; index >= 0; index--) {
    const result = state.results[index];
    if (result.status === STEP_STATUS.FAILED) {
      return { kind: "queue", index, result };
    }
  }
  return undefined;
}

/** Exit code for CLI usage, parsing, and unexpected errors. */
export const CLI_USAGE_EXIT_CODE = 2;

/** Determine the CLI process exit code from the final workflow state. */
export function getExitCode(
  state: Pick<QueueState, "status" | "results">,
  finalStepRuntime?: FinalStepRuntimeState
): number {
  if (state.status === EXECUTION_STATES.COMPLETED) {
    return 0;
  }

  if (state.status === EXECUTION_STATES.ERROR) {
    const failure = selectTerminalFailure(state, finalStepRuntime);
    const failureKind =
      failure?.kind === FINAL_STEP_PHASES.FINAL_STEP
        ? failure.runtime.failureKind
        : failure?.result.failureKind;

    if (failureKind === FAILURE_KINDS.TIMEOUT) {
      return 4;
    }

    if (failureKind === FAILURE_KINDS.HARNESS_NOT_INSTALLED) {
      return 3;
    }
  }

  return 1;
}
