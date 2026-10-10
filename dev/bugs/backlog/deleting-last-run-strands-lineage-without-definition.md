# Deleting a workflow's last run leaves a lineage with no definition, reports a failure, and drops the workflow from the list

- **Found:** 2026-10-10 by claude-cli bug-hunt final step (reproduced with a scratch `npx tsx` script against `WorkflowLineageRepository`/`RunLifecycleService`)
- **Area:** `src/core/orchestration/RunLifecycleService.ts` (`deleteRunAtAddress`, `deleteAllRunsForLineage`), `src/core/orchestration/WorkflowLineageRepository.ts` (`deleteRun`)
- **Severity:** medium

## Symptom

Drill into a workflow whose draft has already been promoted to runs (the
normal state after the first run), click "Delete all runs" (or delete its only
run) and confirm:

- An error toast "Failed to delete all runs" appears, although the runs were
  moved to Recently deleted.
- The workflow disappears from the workflow list.
- On disk only `workflow.json` and an empty `draft/` folder remain; the
  descriptor has no `latestRunRef` and there is no definition file anywhere.
  `WorkspaceSessionManager.discoverSessions` logs
  `Failed to read lineage … ENOENT …draft\workflow.ctrlyoke.json` and skips it.

Undo from Recently deleted restores the runs.

## Steps to Reproduce

1. Create a lineage, start one run (the draft file is removed on promotion),
   let it finish.
2. Delete that run (`deleteRunByRef`) or use "Delete all runs".
3. Observe the empty lineage folder, the ENOENT on refresh and the error toast.

## Root Cause

- `WorkflowLineageRepository.deleteRun` (~473-485) only sets `latestRunRef` to
  `undefined` when the last run goes.
- `RunLifecycleService.deleteRunAtAddress` (~1095-1106) and
  `deleteAllRunsForLineage` (~1167-1173) send every viewer to
  `{ kind: DRAFT }` without checking that a draft file exists.
- `RunViewPublisher.readAddressedRunView` reads the draft unconditionally, so
  the refresh throws `ENOENT`, which `WebviewMessageRouter` (~1873-1886)
  reports as a delete failure.

`dev/implemented/WORKING_FILE_PER_RUN_PLAN.md` (~317) and
`RUN_NAVIGATION_UX_PLAN.md` (~637) specify the fallback "the current draft,
otherwise the latest remaining run, otherwise unloads the deleted lineage.
Deleting the last run removes the lineage only when no draft remains." The
last two branches were never implemented.

## Suggested Fix

In `deleteRunAtAddress`/`deleteAllRunsForLineage`, pick the fallback from
what exists on disk: a draft file if present, else the newest remaining run,
else trash the whole lineage in the same trash batch (so one Undo restores it)
and unload its viewers. Do not report a failure once the runs are in the trash.
Tests in `src/test/unit/WorkflowOrchestrator.test.ts` modelled on
"deleteAllRunsForLineage deletes every non-executing run…": no executing run,
no draft → lineage trashed as one entry, viewers unloaded, no error; with a
draft → fallback is the draft.
