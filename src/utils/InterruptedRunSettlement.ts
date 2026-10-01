import type { WorkingFile } from "../types/CtrlYokeTypes";
import {
  FINAL_STEP_PHASES,
  PROMPT_TERMINAL_STATUS,
  STEP_STATUS,
} from "../types/DashboardConstants";

/**
 * Settle the in-flight work of a run whose owner is gone, in place.
 *
 * A step is claimed for dispatch by writing `_runtime.startedAt`, and a claim
 * is only ever released by writing `completedAt`. An owner that dies mid-step
 * (an extension-host crash, a killed CLI) never writes it, and the dispatch
 * claim refuses a step that is started but not completed (`alreadyClaimed`),
 * so a stopped run that keeps such a step can never be continued. Every path
 * that turns a dead owner's active run into a stopped one must therefore call
 * this, not just rewrite `executionState`: startup lock normalization and the
 * working-file restore that forces a loaded run to STOPPED both do.
 *
 * Every started-but-unsettled step is cancelled (a parallel group can have
 * several in flight); if the current step was one of them the run moves past
 * it, matching what an orderly stop records. With no step in flight, an
 * unfinished final step is cancelled instead.
 *
 * Returns whether anything changed.
 */
export function settleInterruptedRun(
  run: WorkingFile,
  stoppedAt: number = Date.now()
): boolean {
  const runtime = run._runtime;
  if (!runtime) {
    return false;
  }

  const steps = run.steps ?? [];
  const currentIndex = runtime.currentIndex ?? 0;
  let settledStep = false;
  steps.forEach((step, index) => {
    const stepRuntime = step._runtime;
    if (
      stepRuntime?.startedAt === undefined ||
      stepRuntime.completedAt !== undefined
    ) {
      return;
    }
    step._runtime = {
      ...stepRuntime,
      completedAt: stoppedAt,
      terminalStatus: PROMPT_TERMINAL_STATUS.CANCELLED,
    };
    settledStep = true;
    if (index === currentIndex) {
      runtime.currentIndex = currentIndex + 1;
    }
  });
  if (settledStep) {
    return true;
  }

  const finalStep = runtime.finalStep;
  if (
    currentIndex >= steps.length &&
    finalStep?.phase === FINAL_STEP_PHASES.FINAL_STEP &&
    finalStep.status !== STEP_STATUS.COMPLETED
  ) {
    runtime.finalStep = {
      ...finalStep,
      status: STEP_STATUS.CANCELLED,
      completedAt: stoppedAt,
    };
    return true;
  }
  return false;
}
