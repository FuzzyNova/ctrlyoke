# File history continuation cursor re-walks from the snapshot head, so later pages 500

- **Found:** 2026-10-25 by bug-drain review of cd7749ebc
- **Area:** `src/utils/GitUtils.ts` (`getFileHistoryCommitsBounded`), `src/server/HostedWorkspaceViewerService.ts` (`materializeFileHistoryPage`)
- **Severity:** high

## Symptom

In a large repository, the file history of a rarely changed file returns its first
page (cut short by the 10 s deadline, `hasMore: true`), and the next page fails with
HTTP 500. History can never get past what one 10 s `--follow` walk reaches, so the
"last page of any file" case from
`dev/bugs/implemented/file-history-paging-follow-walk-and-filter-gaps.md` still fails.

## Steps to Reproduce

1. In a repo where `git log --follow -- <file>` takes over 10 s to reach the file's
   older commits, open file history.
2. Page 1 returns k rows with `hasMore`.
3. Scroll: page 2 spends its 10 s re-walking past the same k rows, finds nothing
   new, and returns 500.

## Root Cause

The continuation cursor is a raw row count passed to git as `--skip=<cursor>`, so
every request restarts the walk at the snapshot head and repeats all earlier work.
When the deadline expires with zero new rows, `getFileHistoryCommitsBounded` rejects
and `materializeFileHistoryPage` rethrows (`if (entryRows.length === 0) throw error`).

## Suggested Fix

Make the cursor resume where the last walk stopped: encode the last returned commit
hash plus the path it had at that commit (`oldPath` after a rename) in the opaque
cursor, and continue with `git log --follow <lastHash>^ -- <pathAtThatCommit>` (no
`--skip`). Handle a root commit (no parent: no more rows). Keep the cursor opaque to
the client and validate it like `nextOffset` is validated now. If a page times out
with zero new rows, return an empty page with `hasMore: true` and an advanced cursor
(if the walk got any further) rather than a 500. Never loop forever: if it made no
progress, return a clear error. The hosted API contract (`HostedWorkspaceViewerTypes.ts`)
may change only additively.

Tests: a fake-spawn test where page 1 times out and page 2 continues from
`<lastHash>^`, not re-walking; rename continuation uses the old path; a real-git test
paging a renamed file's history across pages. Also add the server test the original
doc asked for: trusted-root filtering across several raw batches.
