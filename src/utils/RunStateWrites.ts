import {
  WORKFLOW_CRITICAL_RENAME_BUDGET_MS,
  type RenameRetryOptions,
} from "./AtomicFileUtils";
import { Log } from "./Log";

/**
 * Retry options shared by every write of a run's persisted state.
 *
 * These are the writes whose failure takes a whole workflow down rather than
 * failing one save, so they get `WORKFLOW_CRITICAL_RENAME_BUDGET_MS` instead of
 * the default window (see `AtomicFileUtils`). The logging exists because a
 * write that waits minutes must not look like a hang: the first wait says a
 * holder turned up, and the periodic line says it has not let go.
 *
 * This lives here, rather than beside either caller, because a run file written
 * through a hand-rolled `writeFile` + `rename` pair gets *no* budget at all and
 * dies on the first transient Windows `EPERM` — which is exactly how
 * `RunContinuationService` used to fail a run mid-flight while
 * `WorkingFileManager` rode the same contention out. One definition keeps the
 * two writers from drifting apart again.
 */
const RUN_STATE_WRITE_RETRY_LOG_INTERVAL_MS = 15_000;

export function runStateWriteOptions(
  filePath: string,
  logLabel: string
): RenameRetryOptions {
  let nextLogAtMs = 0;
  return {
    budgetMs: WORKFLOW_CRITICAL_RENAME_BUDGET_MS,
    onTransientRetry: ({ attempt, elapsedMs, remainingMs, error }) => {
      if (elapsedMs < nextLogAtMs) {
        return;
      }
      nextLogAtMs = elapsedMs + RUN_STATE_WRITE_RETRY_LOG_INTERVAL_MS;
      Log.warn(
        `[${logLabel}] ${filePath} is held by another process ` +
          `(${error.code}); retrying (attempt ${attempt}, ${Math.round(elapsedMs)}ms elapsed, ` +
          `${Math.round(remainingMs)}ms of budget left) rather than failing the run`
      );
    },
  };
}
