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

/** Guardrail stops have a dedicated non-zero code for automation callers. */
export const CLI_GUARDRAIL_STOP_EXIT_CODE = 6;

/** Report an unexpected CLI error and exit with the documented usage code. */
export function handleCliError(
  error: unknown,
  writeError: (message: string) => void = (message) => console.error(message),
  exit: (code: number) => void = (code) => process.exit(code)
): void {
  const message = error instanceof Error ? error.message : String(error);
  writeError(`Error: ${message}`);
  exit(CLI_USAGE_EXIT_CODE);
}

/** Determine the CLI process exit code from the final workflow state. */
export function getExitCode(
  state: Pick<QueueState, "status" | "results" | "stopReason">,
  finalStepRuntime?: FinalStepRuntimeState
): number {
  if (state.status === EXECUTION_STATES.COMPLETED) {
    return 0;
  }

  if (state.stopReason) {
    return CLI_GUARDRAIL_STOP_EXIT_CODE;
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
