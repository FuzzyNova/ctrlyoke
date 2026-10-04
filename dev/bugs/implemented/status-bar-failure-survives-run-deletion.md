# A deleted or trashed failed run stays on the status bar, and clicking it targets the missing run

- **Found:** 2026-10-01 by bug-hunt final step (claude-cli), reviewing b2371ff1f (code reading only, not reproduced)
- **Area:** `src/core/orchestration/WorkflowActivityTracker.ts`, `src/core/orchestration/RunLifecycleService.ts`, `WorkflowOrchestrator.openUnseenFailedRun`
- **Resolution:** fixed in this commit

## Symptom

A session failure is removed from the tracker only by viewing the run, starting
a new run of the lineage, or clicking the bar. Deleting the run, deleting all of
its lineage's runs, or trashing the lineage never removes it, so the bar can keep
showing "1 failed" for a run that no longer exists. Clicking the bar then calls
`switchClientToRunAddress` with the deleted `runRef`. `readAddressedRunView`
fails with ENOENT, and the catch block (`RunLifecycleService.ts` ~544-548) still
sets the client's server-side view address to the missing run, while the webview
keeps showing the previous view. Only after that does the failure get acknowledged.

## Steps to Reproduce (from code reading)

1. A run fails unseen, so the bar shows a failure.
2. Delete that run from history (`deleteRunAtAddress` / `deleteAllRunsForLineage`, `RunLifecycleService.ts` ~1036 / ~1107) or trash its lineage.
3. The bar still shows the failure. Clicking it targets the deleted run.

## Root Cause

`WorkflowActivityTracker` has no hook for forgetting a run, and
`openUnseenFailedRun` doesn't check that the run still exists before switching.

## Suggested Fix

Add a `forgetRun(workflowKey, runRef?)` (or similar) to the tracker, called from
the run/lineage delete and trash paths. In `openUnseenFailedRun`, acknowledge
the failure without navigating when the run is gone. Also check whether the
ENOENT catch in `switchClientToRunAddress` should leave the view address alone.
