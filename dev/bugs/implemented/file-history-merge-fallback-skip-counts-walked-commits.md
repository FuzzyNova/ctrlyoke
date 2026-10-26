# File history merge fallback still drops branch commits and re-walks from HEAD

- **Found:** 2026-10-25 by bug-drain review of 6ba75fc62
- **Area:** `src/server/HostedWorkspaceViewerService.ts` (`materializeFileHistoryPage` cursor fallback, `canResumeFileHistoryCursor`)
- **Resolution:** fixed in this commit

## Symptom

6ba75fc62 (dev/bugs/implemented/file-history-cursor-skips-merged-branch-commits.md) did not
fix the bug it set out to fix once the history has any unrelated commits above the merge,
which is the normal shape of a real repo:

1. Commits from a merged side branch are still silently missing from later pages.
2. In any repository containing a merge (almost all of them), every cursor page restarts
   `git log --follow` at HEAD, so a rarely changed file with a long history pays a deep
   walk per page again. That is the per-page timeout problem 11dd6bf37 fixed
   (dev/bugs/implemented/file-history-follow-cursor-rewalks-from-head.md).

## Steps to Reproduce

Reproduced by the reviewer against the compiled service with real Git 2.47:

1. Commit `base` touching `f.txt`. Branch `side`. Interleave by date: `m1` on main, `s1` on
   side, `m2` on main, `s2` on side, each editing a different line of `f.txt`. Merge `side`
   into `main` with `--no-ff`.
2. Add 10 commits on `main` that only touch `other.txt`.
3. `git log --follow --format=%s -- f.txt` lists `s2,m2,s1,m1,base`.
4. Page `HostedWorkspaceViewerService.getFileHistory("f.txt", …)` with page size 1,
   following `nextCursor`. Result: `s2,m2,m1,base`. **`s1` is never shown.**
5. With 0 unrelated commits it passes, which is the only shape the 6ba75fc62 test covers.

## Root Cause

With `--follow`, Git disables path pruning, and `--skip=N` counts every commit the walk
_visits_, not the rows that touch the file (verified: `git log --follow --skip=N -n1 -- f`
returns the same newest commit for N = 0, 1, 2 when unrelated commits sit above it).

- The merge fallback sets `walkSkip = cursorState.rawOffset` (around line 2395, and again
  after a root commit around line 2452). `rawOffset` counts file-history rows, so the skip
  lands too early and returns rows already shown.
- `seenHashes` filters those out, the batch yields nothing new, and the loop continues the
  next batch from `walkRef = \`${row.hash}^\`` (around line 2462) — the first-parent-only
  resume that is exactly the original bug.
- `canResumeFileHistoryCursor` (around line 2537) disables the fast path whenever
  `rev-list --merges -n 1 HEAD` finds any merge, so the broken fallback is the common path.
  In a merge-free repo that `rev-list` walks the whole history and is re-run on every
  cursor page (not cached on the snapshot), and its rejection (timeout given the whole
  remaining deadline) is not caught, so a large linear repo fails the page with a generic
  exec error instead of falling back.

## Suggested Fix

Stop resuming with `--skip` or `<hash>^` once history contains a merge; resume by position
in Git's own output instead. Options for the fixing step to choose between (record the
choice here):

- Keep one `git log --follow --format=… <headHash> -- <path>` child per history snapshot and
  read it incrementally (pause the stream between pages, kill it on snapshot eviction/TTL),
  so each page continues Git's walk exactly where the last page stopped. Bound the number of
  live children and fall back to a fresh walk if a child was reaped.
- Or, per snapshot, cache Git's ordered output rows as they are produced and continue
  reading from the same stream rather than restarting.

Either way: compute merge-freeness (if still needed) once per snapshot and cache it; treat a
failed or timed-out check as "no fast path"; do not update `seenHashes` until the page
succeeds; do not store a timed-out partial page in `pageCache`.

Tests (real Git, in `src/test/unit/HostedWorkspaceViewerService.test.ts`): the reproduction
above with unrelated commits above the merge (must fail before the fix), a long linear
history of a rarely changed file paged to the end without per-page re-walks from HEAD, and a
rename across a page boundary.

## Fix Applied

- Each file-history snapshot owns one incremental `git log --follow` child and continues
  by raw output position. This preserves Git's complete merge and rename traversal and
  avoids re-walking older rows on each page.
- Pages only advance their cursor and enter the cache after successful materialization;
  a timeout rejects the request so retry starts the uncached page again.
- Live walks are capped at eight per service. Snapshot TTL, count eviction, and service
  disposal kill their child; a later cursor recreates the walk and replays from its head
  to the opaque server-side position. Trusted-root filtering remains on every row.
- Real-Git coverage includes the interleaved merge with unrelated commits above it, a
  rename across pages, and a long linear history. A timed-out page is verified to retry.
