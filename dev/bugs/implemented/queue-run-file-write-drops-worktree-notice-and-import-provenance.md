# Queue run-file writes delete `_runtime.worktreeNotice` and `_runtime.importedFrom`

- **Found:** 2026-11-25 by bug-hunt workflow final step (Claude subagent, reproduced against `out/`)
- **Area:** `src/core/WorkingFileManager.ts` (`updateWorkingFile` `_runtime` rebuild ~2841-2858, `updateWorktreeNotice` ~2991-3013)
- **Resolution:** fixed in this commit

## Symptom

The queue's ordinary run-file write keeps only the `_runtime` fields it builds
itself plus `worktree` and `lastActivityAt`. Every other `_runtime` field on
disk is silently deleted on the next queue write, including:

- `worktreeNotice`: written once at startup by `updateWorktreeNotice`
  (`WorkflowStartupPipeline.ts` ~1106) and read by `OutputHistoryManager.ts`
  (~1226, ~1613), `WorkspaceSessionManager.ts` (~358) and
  `GlobalWorkflowStatusService.ts` (~232). The next step-status or runtime flush
  erases it, so the notice disappears from history and status.
- `importedFrom`: the provenance and `viewOnly` reason of an imported run.

## Steps to Reproduce

1. `npm run compile:extension`.
2. Seed an anchored v4 run file whose `_runtime` includes
   `worktreeNotice: "…"` and `importedFrom: { … }`.
3. Point a `PromptQueue` at it (`restoreFromWorkingFile`) and call
   `updateWorkingFile()`.
4. **Actual:** on disk `_runtime` is
   `{"currentIndex":0,"executionState":"idle","schemaVersion":4}`. Both fields
   are gone.

**Expected:** fields the queue doesn't own survive the write unchanged.

## Root Cause

`WorkingFileManager.ts` ~2841-2858 assigns `workingFile._runtime = { … }` from
queue state, copying only `worktree` and `lastActivityAt` from the disk copy.
`updateWorktreeNotice` (~2991) does the right thing (`...currentRuntime`), but
the next queue write undoes it. `.github/instructions/utils.instructions.md`
requires run-file writers to carry the `_runtime` they read forward by spread,
never field by field.

## Suggested Fix

Start from `...workingFile._runtime` (disk) and override only the queue-owned
fields, deleting the optional queue-owned ones that are now absent. This is the
same change that fixes
`queue-run-file-write-downgrades-newer-schema-run.md`, so fix them together.
Add a unit test that `worktreeNotice` and `importedFrom` survive
`updateWorkingFile()`, and that a cleared `finalStep`/`activeParallelGroup`/
`pendingRewind` is still removed.
