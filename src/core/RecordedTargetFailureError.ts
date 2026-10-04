import type { WorkflowAttemptTarget } from "../types/CtrlYokeTypes";
import { getErrorMessage } from "../utils/ErrorUtils";

/**
 * A terminal target failure the executor has already settled: the step (or
 * final-step pass) is marked failed, the runtime is in ERROR, and the queue may
 * already have moved past the step. `WorkflowExecutor` still rethrows it so the
 * startup path can surface the reason, but that path must not fail the queue's
 * "in-flight" step for it — `currentIndex` can by now name the next step, which
 * never started — and must attribute the failure to `target` instead.
 */
export class RecordedTargetFailureError extends Error {
  constructor(
    readonly target: WorkflowAttemptTarget,
    cause: unknown
  ) {
    super(getErrorMessage(cause), { cause });
    this.name = "RecordedTargetFailureError";
    if (cause instanceof Error && cause.stack) {
      this.stack = cause.stack;
    }
  }
}
