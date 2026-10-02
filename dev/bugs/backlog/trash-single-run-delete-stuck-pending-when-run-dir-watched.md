# Deleting a single run whose directory is watched strands it in a `.pending` trash entry (Windows)

- **Found:** 2026-10-02 by bug-hunt final step (claude-cli subagent), reproduced on Windows with `fs.watch(runDir)` standing in for VS Code's run-file watcher
- **Area:** `src/core/orchestration/HistoryTrashRepository.ts` (`HistoryTrashBatch.moveRunDir`, `publishEntry` ~503-528, `movePath` ~102-142)
- **Severity:** medium

## Symptom

`.github/instructions/orchestration.instructions.md` notes that VS Code watches
the directory of every open workflow's run file, and that is why `movePath` has
a copy fallback. For a **single-run** delete (`deleteRunAtAddress` →
`deleteRunByRef` → `moveRunDir`), Windows still lets the watched run directory
itself be renamed. So `movePath` succeeds with a plain rename, and the
watcher's handle moves into `<trash>/<id>.pending/payload/<key>/<runRef>`.
`publishEntry` then renames the whole `<id>.pending` directory, an ancestor of
an open handle. Windows refuses that with `EPERM` until the 2 s retry budget runs
out, so the delete fails:

- The run is gone from the lineage (history shows it removed).
- `.trash` holds only `<id>.pending`, so Recently deleted shows nothing and Undo isn't offered.
- `recoverPendingEntries` skips pending entries whose owner pid is alive, so the
  run stays invisible until the host restarts, even after the watcher closes.

Whole-lineage deletes avoid this because renaming the lineage dir fails up
front, so the copy fallback runs.

## Steps to Reproduce

1. On Windows, `fs.watch(<runDir>)` (or open that run in the dashboard so VS Code watches it).
2. Delete that single run from history.
3. The delete reports an error. The run vanishes from history, and Recently deleted is empty.

## Root Cause

`publishEntry` uses `renameWithTransientRetry(pendingDir, target)` and has no
fallback for an open handle inside the payload. The fallback in `movePath` only
covers the first move, and that move succeeds here.

## Suggested Fix

Make publishing robust to handles inside the payload. One option is to treat a
`COPY_FALLBACK_ERROR_CODES` failure in `publishEntry` the same way `movePath`
does: create the target entry dir, then move or copy `payload` children
individually with `movePath`, writing `entry.json` last. Another is to have
`moveRunDir` always copy-then-delete for a single run. Whichever you choose,
`entry.json` must only appear once the payload is complete, so the pending/commit
crash-recovery semantics still hold. Add a Windows-only Mocha test that holds
`fs.watch` on the run dir during delete and asserts the entry is listed and
restorable.
