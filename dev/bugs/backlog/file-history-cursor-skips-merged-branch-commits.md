# File history cursor skips commits from merged branches

- **Found:** 2026-10-25 by bug-drain review of 11dd6bf37
- **Area:** `src/server/HostedWorkspaceViewerService.ts` (`materializeFileHistoryPage`, file-history cursor helpers)
- **Severity:** high

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

The tests in `src/test/unit/HostedWorkspaceViewerService.test.ts` fake the spawn with a
linear history, so they cannot catch this. The real-git test the original bug doc asked
for (paging a renamed file across pages) is missing.

### Secondary (low): the cursor exposes untrusted paths

`continuationCursor` is built for every consumed row, including rows filtered out because
they are outside the trusted roots. The returned `nextCursor` is plain base64url JSON, so
a rename from `secret/a.txt` into a trusted root leaks `"path":"secret/a.txt"` and its
commit hash. The server only checks `historyId` when decoding, so a forged cursor can also
point the walk at any normalized relative path (including pathspec magic such as
`:(glob)…`) and probe its rename and commit metadata. No row content is returned.

### Residual limitation (document, don't necessarily fix)

When the walk from a cursor finds no commit within the page deadline, the request fails
with a plain `Error` (HTTP 500) every time, so "Retry" can never move past that gap. The
`catch` around line 2412 also reports real git failures with the same "timed out" text.

## Suggested Fix

1. Only use the cursor fast path when it is exact: keep resuming from the cursor when
   `git rev-list --merges -n1 <hash>..<snapshotHead>` shows no merge in between and the
   commit has a parent; otherwise fall back to the bounded `--skip` walk from the snapshot
   head that cd7749ebc introduced. (Resuming from `<hash>^@` alone is still wrong — it
   loses commits on branches that do not descend from that commit.) An alternative that
   is also correct: store the set of still-pending tips with the cursor server-side.
2. Drop the `reachedRoot` shortcut, or only apply it when the snapshot history has a
   single root.
3. Keep cursor state on the server inside the history snapshot, behind an opaque random
   token, instead of serializing `path`/`hash` into the client-visible cursor. Never put an
   untrusted path into anything returned to the client.
4. Distinguish a real git failure from the deadline in the error message.
5. Add real-git tests: interleaved branch commits paged at page size 1 (every commit
   appears exactly once, in `git log` order), a rename paged across pages, and a forged or
   foreign cursor rejected with `WorkspaceTreeBadRequestError`.
