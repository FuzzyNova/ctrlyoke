# File history cursor skips commits from merged branches

- **Found:** 2026-10-25 by bug-drain review of 11dd6bf37
- **Area:** `src/server/HostedWorkspaceViewerService.ts` (`materializeFileHistoryPage`, file-history cursor helpers)
- **Resolution:** fixed in this commit

## Symptom

Paging a file's history in the hosted workspace viewer silently drops commits when the
history contains merges. Commits made on a side branch before it was merged are missing
from every page after the first page boundary that falls on the other branch.

## Steps to Reproduce

Reproduced with real git by the reviewer:

1. Commit `base` touching `f.txt`. Branch `side`, commit `side1` (dated Jan 3) editing
   `f.txt`; on `main`, commit `main1` (dated Jan 2) editing `f.txt`; merge `side`.
2. `git log --follow -- f.txt` lists side1, main1, base.
3. Page the file history with page size 1. Page 1 is side1. Its cursor resumes with
   `git log --follow <side1>^ -- f.txt`, which returns only `base`. `main1` is never shown.

## Root Cause

11dd6bf37 resumes each page from the last consumed commit's first parent
(`walkRef = \`${decoded.hash}^\``, around line 2383, and the same reset between batches
inside one page around line 2437). `git log` walks all branches in date order, so commits
from other branches are still pending when a page ends; `<hash>^` contains only that
commit's own first-parent ancestry. `reachedRoot` (around line 2428) also stops the walk at
the first parentless commit, cutting off history in repos with several root commits
(subtree merges, merged orphan branches).

The existing fake-spawn tests used a linear history and could not catch this. They also
did not cover the real-Git rename pagination case.

### Secondary (low): the cursor exposes untrusted paths

`continuationCursor` is built for every consumed row, including rows filtered out because
they are outside the trusted roots. The returned `nextCursor` is plain base64url JSON, so
a rename from `secret/a.txt` into a trusted root leaks `"path":"secret/a.txt"` and its
commit hash. The server only checks `historyId` when decoding, so a forged cursor can also
point the walk at any normalized relative path (including pathspec magic such as
`:(glob)…`) and probe its rename and commit metadata. No row content is returned.

### Residual limitation (document, don't necessarily fix)

When the walk from a cursor finds no commit within the page deadline, the request still
fails with a clear no-progress deadline error (HTTP 500), so "Retry" cannot move past
that gap. This limitation remains. Real Git failures now keep their Git error message
instead of being reported as timeouts.

## Fix Applied

- Cursor state now stays in the history snapshot behind a random UUID token. A cursor
  resumes from its commit only when the frozen history is merge-free and the commit has a
  parent; otherwise paging falls back to a bounded walk from the snapshot head.
- Cursor fallback tracks already-emitted hashes and caches page results so Git's merge
  traversal does not repeat visible commits and retries remain stable.
- The root-commit stop shortcut is removed. Git failures retain their error text, while
  deadline gaps report a distinct no-progress error.
- Real-Git tests cover interleaved merged branches at page size one, rename paging, and a
  cursor from a different history snapshot.
