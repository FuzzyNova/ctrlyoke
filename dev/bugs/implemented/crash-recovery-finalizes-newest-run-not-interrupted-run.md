# Crash recovery finalizes the newest run instead of the interrupted one

- **Found:** 2026-10-15 by claude-cli bug-hunt final step (traced through the code; `OutputHistoryManager` needs the extension host, so not run end to end)
- **Area:** `src/core/orchestration/ExternalRunWatchCoordinator.ts`, `src/core/orchestration/OutputHistoryManager.ts`
- **Resolution:** fixed in this commit

## Symptom

After a crash, the interrupted run's `manifest.json` can stay in an active
state forever. The dashboard shows it as Stopped (display prefers the working
file), but:

- deleting it fails with `Cannot delete a protected run`;
- "Delete all runs" silently leaves it behind (the error is only logged as a
  warning in `RunLifecycleService.ts` around line 1197);
- `runs.maxRuns` retention never prunes it;
- it never gets `RUN_TERMINATED` or `completedAt`, so usage figures miss it.

## Steps to Reproduce

Either:

1. **An older run is continued.** Continue a run that is not the lineage's
   newest (`appendAndContinueAtRun` / `continueAtRun` allow this), then kill
   VS Code mid-step. On restart `normalizeStaleLocks` sets that run's working
   file to STOPPED, but `recoverInterruptedRun` inspects the newest run, finds
   it COMPLETED, and does nothing. The older run's manifest (set to RUNNING by
   `reopenRun`) stays RUNNING.
2. **A crash while the newest run is PAUSING or CANCELLING.**
   `appendRuntimeTransition` (`OutputHistoryManager.ts` around line 881) writes
   that state into the manifest; `recoverInterruptedRun` only finalizes
   `RUNNING`, so it skips it.

## Root Cause

- `ExternalRunWatchCoordinator.ts` (around lines 216-236) knows the exact
  interrupted run (`recoveredAddress.runRef`) but calls
  `recoverInterruptedRun(workflowKey, stepCount)` without it.
- `OutputHistoryManager.recoverInterruptedRun` (around lines 1086-1105) picks
  the newest run (`const [latestRun] = …getRunsForWorkflow`) and finalizes it
  only when its manifest state is exactly `RUNNING`.
- `getProtectedRunRefs` (around lines 1654-1676) protects any run whose
  manifest state is active, so the stale manifest blocks deletion forever.

## Suggested Fix

Pass `recoveredAddress.runRef` through to `recoverInterruptedRun` and finalize
that exact run's manifest. Treat any in-flight manifest state (RUNNING,
PAUSING, CANCELLING — i.e. the active states other than PAUSED) as needing
finalization. Update the "newest run only" statement in
`.github/instructions/orchestration.instructions.md` accordingly, and add unit
tests for both scenarios.
