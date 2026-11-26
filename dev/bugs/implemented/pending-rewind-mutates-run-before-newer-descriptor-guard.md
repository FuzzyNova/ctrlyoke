# Rewinding a run under a newer `workflow.json` rewrites the run file before refusing

- **Found:** 2026-11-25 by bug-hunt final step (subagent code review, reproduced)
- **Area:** `src/core/orchestration/WorkflowLineageRepository.ts`, `src/core/WorkingFileManager.ts`
- **Resolution:** fixed in this commit

## Symptom

When the lineage descriptor (`workflow.json`) was written by a newer ctrlyoke,
starting a pending rewind ("continue from step N") throws `NewerSchemaError`,
but only after it has already rewritten the run file (step runtimes from the
rewind point cleared, `_runtime.pendingRewind` set, `definitionRevision` bumped)
and written a rewind snapshot. The descriptor gets no `pendingEdit`, so the next
continuation's `clearOrphanedPendingRewind` (`RunLifecycleService.ts` ~873)
treats the rewind as orphaned, strips the marker and deletes the snapshot — the
cleared step history is then lost for good. Older ctrlyoke versions must leave
newer-version state read-only (`src/utils/PersistedSchemaGuard.ts`).

## Steps to Reproduce

1. Create a lineage and promote a completed 2-step run (workspace run-history mode).
2. Set `workflow.json` `schemaVersion` to 99.
3. Call `WorkingFileManager.beginPendingRewind(ws, key, runRef, 1, 1, rev)`.
4. It rejects with `NewerSchemaError`, yet the run file now has
   `definitionRevision` 2, `pendingRewind: {fromStepIndex: 1, …}`, step 2's
   `_runtime` reduced to `{stepId}`, and the snapshot exists.
5. `clearOrphanedPendingRewind` then returns `true`, removes the marker and
   deletes the snapshot.

## Root Cause

`WorkflowLineageRepository.mutateDescriptorAtRevision` (~659-683) reads the
descriptor and runs the caller's `mutate` (which writes files) before any schema
check; the first `assertWritableSchema` is in `writeDescriptorDirect` (~839),
after `mutate` returns. `beginPendingRewind` (`WorkingFileManager.ts` ~1355-1446)
writes the snapshot and the run file inside that `mutate`; `commitPendingRewind`
and `discardPendingRewind` have the same ordering. The earlier fix for
`dev/bugs/implemented/delete-run-ignores-newer-lineage-descriptor-schema.md`
only covered `deleteRun`/`restoreRuns`.

## Suggested Fix

In `mutateDescriptorAtRevision`, call
`assertWritableSchema(PERSISTED_STORES.LINEAGE_DESCRIPTOR, descriptor, descriptorPath)`
right after `readDescriptor`, before `mutate`, so every caller refuses before
touching files. Check other descriptor read-modify-write helpers for the same
ordering.

Tests: `src/test/unit/WorkingFileManager.test.ts` `suite("beginPendingRewind")`
— newer descriptor rejects with `NewerSchemaError`, run-file bytes unchanged, no
snapshot; similar cases for commit and discard.
