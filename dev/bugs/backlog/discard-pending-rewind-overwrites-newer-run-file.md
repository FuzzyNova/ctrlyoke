# Discarding a pending rewind overwrites a newer-format run file

- **Found:** 2026-11-25 by bug-hunt final step (subagent code review, reproduced)
- **Area:** `src/core/WorkingFileManager.ts`
- **Severity:** medium

## Symptom

`discardPendingRewind` restores the rewind snapshot over the run file even when
the current run file's `_runtime.schemaVersion` is newer than this ctrlyoke
understands. The newer host's run file is silently downgraded and its unknown
fields are dropped, violating the rule that newer-version state stays read-only
(`src/utils/PersistedSchemaGuard.ts`). The sibling `commitPendingRewind`
correctly refuses.

## Steps to Reproduce

1. Call `beginPendingRewind` on a current-format run.
2. Edit the run file so `_runtime.schemaVersion = 99` and
   `_runtime.futureField = "keep-me"` (as a newer host editing the pending run
   would leave it).
3. Call `discardPendingRewind(…, confirmEditedSuffix = true)`.
4. It returns `discarded: true`; the run file now has `_runtime.schemaVersion: 4`,
   `futureField` is gone, the snapshot is deleted and the descriptor's
   `pendingEdit` cleared.

## Root Cause

`discardPendingRewind` (`WorkingFileManager.ts` ~2279 onward) reads the current
file with `readWorkingFileFromDisk`, whose `normalizeParsedWorkingFile`
(~199-210) only guards the `WORKFLOW_DEFINITION` version, not the `_runtime`
`RUN_FILE` version. It then writes the snapshot bytes with
`restoreSnapshotAtomic` (~498), which bypasses `prepareRunFileForWrite` — the
only run-file writer without a `RUN_FILE` guard.

## Suggested Fix

Inside the run-file lock in `discardPendingRewind`, call
`assertWritableSchema(PERSISTED_STORES.RUN_FILE, current._runtime, runFilePath)`
before `restoreSnapshotAtomic`, or put the guard inside `restoreSnapshotAtomic`
so no caller can bypass it.

Tests: `src/test/unit/WorkingFileManager.test.ts`, next to the existing
`discardPendingRewind` tests — rejects with `NewerSchemaError`, run file and
snapshot untouched.
