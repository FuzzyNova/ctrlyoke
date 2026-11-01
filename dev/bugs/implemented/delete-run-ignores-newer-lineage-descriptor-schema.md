# Deleting or restoring a run moves files before checking for a newer `workflow.json` schema

- **Found:** 2026-11-01 by bug-hunt final step (claude-cli)
- **Area:** `src/core/orchestration/WorkflowLineageRepository.ts`, `src/core/orchestration/RunLifecycleService.ts`
- **Resolution:** fixed in this commit

## Symptom

A lineage whose `workflow.json` was written by a newer ctrlyoke is meant to be
read-only (`src/utils/PersistedSchemaGuard.ts`). Even so, an older ctrlyoke
still deletes its runs:

- Dashboard **Delete Run**: the run moves to Recently deleted and a success
  toast appears. The descriptor write is then refused with
  `NewerSchemaError`, but `RunLifecycleService.ts:1162` (`if (trash.isEmpty)
throw error;`) treats that as "post-delete work failed" and only logs it.
  The newer host's descriptor keeps a `latestRunRef` that points at the
  missing run. If that was the last run, the whole lineage directory, newer
  descriptor included, can also be trashed.
- Callers that pass no trash batch see the error, but the run has already
  been moved or removed.
- `restoreRuns` has the same order: `moveIn(lineageDir)` runs
  (`WorkflowLineageRepository.ts:526`) before the descriptor write is refused.

## Steps to Reproduce

1. In a lineage under `.runs/<workflowKey>/`, set `workflow.json`'s
   `schemaVersion` to one above the current `LINEAGE_DESCRIPTOR` version.
2. Delete one of its runs from the dashboard history.
3. The run disappears and a success toast is shown, even though the store is
   newer and should be read-only.

## Root Cause

`WorkflowLineageRepository.deleteRun` (`:430` onward) reads the descriptor and
calls `removeRunDir(runDir)` with no schema check. The only
`assertWritableSchema` call is in `writeDescriptorDirect` (`:807`), and that
runs after the directory has already moved. `restoreRuns` (`:511`) does the
same: it calls `moveIn` first and writes the descriptor afterwards.

## Suggested Fix

Call
`assertWritableSchema(PERSISTED_STORES.LINEAGE_DESCRIPTOR, descriptor, descriptorPath)`
right after reading the descriptor in `deleteRun`, before `removeRunDir`, and
in `restoreRuns`, before `moveIn`. Check whether `HistoryTrashBatch.moveLineageDir`
or any other path that moves a whole lineage needs the same check. Add tests
with a newer-version descriptor that assert the run directory is untouched and
`NewerSchemaError` reaches the caller. Also confirm that
`RunLifecycleService.deleteRun` surfaces the error, which it will because the
batch stays empty.
