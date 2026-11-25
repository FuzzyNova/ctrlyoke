# Queue run-file writes overwrite a newer ctrlyoke's run and downgrade it to the current schema

- **Found:** 2026-11-25 by bug-hunt workflow final step (Claude subagent, reproduced against `out/`)
- **Area:** `src/core/WorkingFileManager.ts` (`writeQueueState` / `updateWorkingFile`, ~2710-2870), `src/core/PromptQueue.ts` (`restoreFromWorkingFile`), `src/utils/PersistedSchemaGuard.ts` (`prepareRunFileForWrite`, ~209-234)
- **Severity:** high

## Symptom

A run file written by a newer ctrlyoke (`_runtime.schemaVersion` above
`CURRENT_SCHEMA_VERSIONS` for the run file, currently 4) must be read-only to
this build. Instead, just loading it into the queue rewrites it: the run is
forced to `stopped`, every `_runtime` field this build doesn't know is
deleted, and `schemaVersion` is stamped back down to 4. Every later queue
write (step edit, runtime flush) does the same. The newer host then reads a
run whose state and fields were destroyed by an older one, which is the data
loss `PersistedSchemaGuard` exists to prevent.

## Steps to Reproduce

1. `npm run compile:extension`.
2. Write an anchored run file (`writeAnchoredRunDefinition` from
   `out/utils/RunDefinitionAnchor.js`) whose `_runtime` is
   `{ schemaVersion: 5, currentIndex: 0, executionState: "running", futureField: "v5-only" }`.
3. `await new PromptQueue().restoreFromWorkingFile(file, true)`. This is the
   path used by `WorkflowInstance.autoLoadFromWorkingFile` and
   `restoreWorkflowFromWorkingFile`.
4. Read the file back. **Actual:** `_runtime` is
   `{"currentIndex":0,"executionState":"stopped","schemaVersion":4}` and no
   error was thrown. A following `updateWorkingFile()` also succeeds and writes
   the same.

**Expected:** the write is refused with `NewerSchemaError` (through
`assertWritableSchema`) and the file stays byte-for-byte unchanged. The run can
still be loaded and displayed.

## Root Cause

- `WorkingFileManager.ts` ~2841-2858: after reading the file from disk, the
  writer replaces `workingFile._runtime` with an object it builds field by field
  (`currentIndex`, `executionState`, `tokenTotals`, timing, `finalStep`,
  `activeParallelGroup`, `pendingRewind`, `worktree`, `lastActivityAt`). The
  disk copy's `schemaVersion` is not carried over.
- `PersistedSchemaGuard.prepareRunFileForWrite` (~209-234) only checks the
  `_runtime` it is handed. With the version gone, the check passes and it
  stamps the current version.
- Nothing upstream catches it: `readVerifiedWorkingFile` /
  `normalizeParsedWorkingFile` only check the top-level workflow-definition
  version, and `PromptQueue.restoreFromWorkingFile`'s forced-STOPPED write
  never calls `isNewerRunFile`.
- `.github/instructions/utils.instructions.md` states the contract: the
  run-file guard needs no extra I/O only because every writer carries forward
  the `_runtime` it read; a writer that rebuilds `_runtime` from queue state
  "must check the file it came from explicitly". `promoteToNewRun` (~931) and
  `seedNewRun` (~1069) do. This writer doesn't.
  `ExternalRunWatchCoordinator.ts` ~1032 guards the same RUNNING→STOPPED
  normalization ("A newer ctrlyoke's run is displayed as stopped but never
  rewritten"); the queue's load path has no equivalent.

## Suggested Fix

- In the queue writer, build the new `_runtime` from `...workingFile._runtime`
  (the disk copy) and override only the queue-owned fields, explicitly deleting
  the optional ones the queue clears on purpose (`finalStep`,
  `activeParallelGroup`, `pendingRewind`, `tokenTotals`, timing fields when
  absent). The disk `schemaVersion` then reaches `prepareRunFileForWrite` and
  the guard refuses the write. This also fixes
  `queue-run-file-write-drops-worktree-notice-and-import-provenance.md`.
  Alternatively, or in addition, call
  `assertWritableSchema(PERSISTED_STORES.RUN_FILE, diskRuntime, path)` right
  after the disk read.
- In `PromptQueue.restoreFromWorkingFile`, skip the forced-STOPPED write-back
  when `isNewerRunFile(workingFile)` is true, matching
  `ExternalRunWatchCoordinator`, so loading a newer run for display does not
  throw or write.
- Tests (`src/test/unit/`): a newer-version run file survives
  `restoreFromWorkingFile` + `updateWorkingFile` unchanged, and the update
  rejects with `NewerSchemaError`.
