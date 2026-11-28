import {
  EXECUTION_STATES,
  FINAL_STEP_PHASES,
  PARALLEL_DISPATCH_REFUSALS,
  type ExecutionState,
  type FinalStepPhase,
} from "@root/types/DashboardConstants";

export interface ParallelDispatchState {
  executionState: ExecutionState;
  finalStepPhase: FinalStepPhase | null;
  activeStepIndices: readonly number[];
  effectiveParallelGroupWidth: number;
}

/**
 * Why nothing can be started beside the running step of the displayed run, or
 * `undefined` when it can. The single order of refusals for the prompt
 * editor's Run in Parallel and the switcher's "Run Workflow Alongside Current
 * Step…", which the backend refuses for the same reasons.
 */
export function getParallelDispatchRefusal(
  state: ParallelDispatchState
): string | undefined {
  if (state.executionState === EXECUTION_STATES.PAUSING) {
    return PARALLEL_DISPATCH_REFUSALS.pausing;
  }
  if (state.executionState !== EXECUTION_STATES.RUNNING) {
    return PARALLEL_DISPATCH_REFUSALS.noStepRunning;
  }
  if (state.finalStepPhase === FINAL_STEP_PHASES.FINAL_STEP) {
    return PARALLEL_DISPATCH_REFUSALS.finalStep;
  }
  if (state.activeStepIndices.length === 0) {
    return PARALLEL_DISPATCH_REFUSALS.noStepRunning;
  }
  if (state.effectiveParallelGroupWidth <= 1) {
    return PARALLEL_DISPATCH_REFUSALS.widthOne;
  }
  return undefined;
}
