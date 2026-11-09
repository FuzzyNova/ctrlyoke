import {
  EXECUTION_STATES,
  FINAL_STEP_PHASES,
  STEP_STATUS,
} from "../types/DashboardConstants";
import type {
  FinalStepRuntimeState,
  PromptResult,
  QueueState,
} from "../types/CtrlYokeTypes";

export const TERMINAL_FAILURE_KINDS = { QUEUE: "queue" } as const;

export type TerminalFailure =
  | {
      kind: typeof TERMINAL_FAILURE_KINDS.QUEUE;
      index: number;
      result: Pick<PromptResult, "status" | "error" | "failureKind">;
    }
  | {
      kind: typeof FINAL_STEP_PHASES.FINAL_STEP;
      runtime: FinalStepRuntimeState;
    };

/** Select the failed step that made an errored workflow stop. */
export function selectTerminalFailure(
  state: Pick<QueueState, "status"> & {
    results?: readonly Pick<
      PromptResult,
      "status" | "error" | "failureKind"
    >[];
  },
  finalStepRuntime?: FinalStepRuntimeState
): TerminalFailure | undefined {
  if (state.status === EXECUTION_STATES.COMPLETED) return undefined;
  if (
    state.status === EXECUTION_STATES.ERROR &&
    finalStepRuntime?.status === STEP_STATUS.FAILED
  ) {
    return { kind: FINAL_STEP_PHASES.FINAL_STEP, runtime: finalStepRuntime };
  }
  const results = state.results ?? [];
  for (let index = results.length - 1; index >= 0; index--) {
    const result = results[index];
    if (result.status === STEP_STATUS.FAILED) {
      return { kind: TERMINAL_FAILURE_KINDS.QUEUE, index, result };
    }
  }
  return undefined;
}
