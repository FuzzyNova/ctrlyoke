# Recent workflow catalog drops cancelling execution owners

- **Found:** 2026-11-08 by smell hunt pass 6
- **Area:** `src/core/orchestration/RecentWorkflowCatalog.ts`
- **Resolution:** fixed in this commit

## Symptom

While a workflow is CANCELLING, a recent-workflow scan can treat its working
file as unowned and normalize a still-running on-disk state to STOPPED.

## Steps to Reproduce

1. Start a workflow and request cancellation while its executor is still active.
2. Let a recent-workflow list scan begin before the final working-file write.
3. Observe the row report STOPPED before cancellation has finished.

## Root Cause

`collectActiveWorkingFilePaths` tracked RUNNING, PAUSING, and PAUSED instances,
but omitted CANCELLING, even though that state still owns the working file.

## Resolution

The catalog now uses `ACTIVE_EXECUTION_STATES`, and a regression test verifies
that a cancelling instance keeps a stale RUNNING working file active during a
scan.
