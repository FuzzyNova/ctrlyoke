# File history walk drops partial pages at the deadline and leaks killed walks

- **Found:** 2026-10-25 by bug-drain review of 13ec967d2
- **Area:** `src/server/HostedWorkspaceViewerService.ts` (`materializeFileHistoryPage`), `src/utils/GitUtils.ts` (the streaming `git log --follow` walk added in 13ec967d2)
- **Resolution:** fixed in this commit

## Symptom

13ec967d2 (dev/bugs/implemented/file-history-merge-fallback-skip-counts-walked-commits.md)
replaced the `--skip`/`<hash>^` resume with one live `git log --follow` process per history
snapshot, read by exact output position. Merge ordering is now correct, but:

1. **A slow first page can never load (high, regresses 11dd6bf37).** In
   `materializeFileHistoryPage` the loop `while (entryRows.length <= snapshot.pageSize)`
   throws `"Git file history timed out; retry the request"` once the deadline passes,
   discarding rows already collected. The pre-13ec967d2 code returned them as a partial page
   with `hasMore` and a cursor. For a rarely changed file in a deep repo where finding
   `pageSize + 1` matching rows takes longer than `GIT_COMMAND_TIMEOUT_MS`, the first request
   throws; the client has no `historyId` yet, so its retry creates a **new** snapshot and a
   new walk from HEAD and times out the same way every time. Each failed attempt also leaves
   its git process alive in an unreachable snapshot until the TTL or the
   `FILE_HISTORY_MAX_LIVE_WALKS` cap evicts it, pushing out walks of real histories.
2. **Disposing a walk leaks its pipe and buffers (medium).** The walk's `dispose()` only calls
   `child.kill()`. The stdout stream is usually paused when the walk is disposed, so it never
   reaches end-of-file and `close` never fires (verified: spawn git, pause stdout after one
   chunk, kill → `exit null SIGTERM` fires, `close` never does, stdout stays
   `destroyed=false`). Every TTL/count/cap eviction leaks an open pipe handle plus the walk's
   `chunks` array and parsed rows. A `readAt` in flight on an evicted walk hangs until its
   timeout instead of failing at once, because `closed` is never set.
3. **Output is re-parsed in full on every chunk (low/medium, perf).** Each stdout chunk runs
   `Buffer.concat(chunks).toString()` and `parseFileHistoryCommitOutput` over everything
   received so far — quadratic in output size, and both chunks and rows are kept. Deep paging
   on a file with tens of thousands of commits shows up as `[EventLoopStall]`.

## Suggested Fix

1. When the deadline passes with at least one trusted row collected, return a partial page
   (`hasMore: true`, a cursor token at the current `position`). Positions are exact, so the
   page is correct and safe to cache. Throw only when no rows were found, and dispose the
   snapshot's walk (and drop the snapshot) when a **first** page fails so it is not left
   orphaned.
2. In `dispose()`: destroy `child.stdout`/`child.stderr`, kill the child, set `closed = true`
   with a disposal failure, clear `chunks`/`rows`, and wake any pending reader so it rejects
   immediately.
3. Parse incrementally: keep only the unparsed tail after the last complete record and append
   newly parsed rows; don't retain the raw chunks once parsed.
4. Tests: a deadline hit after some rows returns a partial page whose cursor continues
   correctly; a first-page failure disposes its walk; `dispose()` closes the child's streams
   and rejects a pending `readAt` promptly; incremental parsing yields the same rows as a
   whole-buffer parse when records are split across chunk boundaries.
