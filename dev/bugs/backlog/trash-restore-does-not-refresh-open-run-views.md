# Undo of a run delete doesn't bring the run back into the open run list

- **Found:** 2026-09-30 by bug-backlog final step (claude-cli, code review)
- **Area:** `src/ui/WorkflowSerializer.ts` (`handleHistoryTrashAction`), `src/core/orchestration/RunLifecycleService.ts`
- **Severity:** medium

## Symptom

Deleting a run reloads the run view for every client viewing that lineage
(`RunLifecycleService.deleteRunAtAddress` → `loadRunViewForClient` for each target, then
`pushRunSummariesRefreshIfNotAlreadyViewing`). Restoring it does not. When the user clicks
**Undo** on the "Moved Run N to Recently deleted" toast, or **Restore** in Settings →
Recently deleted, the run goes back on disk and the workflow list is resent. The displayed
lineage's run panel and run count stay as they were after the delete, and the restored run
isn't listed until the user switches workflows or reloads.

The same applies to **Delete all runs** followed by Undo. The viewer was moved to the
draft fallback and stays there, with an empty run list, even though every run is back.

## Steps to Reproduce

1. Open a lineage with at least two runs, viewing Run 2.
2. Delete Run 1 from the run panel. The panel refreshes and shows one run.
3. Click **Undo** on the toast. A toast says "Restored 1 run", but the run panel still
   shows one run.

## Root Cause

`handleHistoryTrashAction` for `HISTORY_TRASH_ACTIONS.RESTORE` (`WorkflowSerializer.ts`
~l.1641) only replies with `HISTORY_TRASH_RESULT` and calls `handleGetRecentWorkflows`. The
displayed lineage's `uiStore.runSummaries` is set only by `RUN_VIEW_LOADED`
(`setDisplayedRunView`), and nothing sends one after a restore. The
`HISTORY_TRASH_RESULT` handler in `useMessageHandler.ts` only clears the pending flag and
shows a toast. `HistoryTrashRestoreResult` also doesn't say which lineages were affected,
so the caller couldn't target a refresh even if it tried.

## Suggested Fix

Make `HistoryTrashRepository.restore` report the restored workflow keys. After a
successful restore, do the same view refresh that `deleteRunAtAddress` does, single-sourced
in one orchestrator/RunLifecycleService helper rather than copied:

- reload the run view for every client whose view address is on a restored lineage, and
  move a client left on a draft fallback back to the latest run;
- `pushRunSummariesRefreshIfNotAlreadyViewing` for drilled run-panel caches.

Route the RESTORE action through that helper. Tests: restoring a run into a lineage that a
client is viewing sends that client a `RUN_VIEW_LOADED` that includes the run.
