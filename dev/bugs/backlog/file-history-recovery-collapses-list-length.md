# Recovering an expired file-history listing collapses the list and loses scroll position

- **Found:** 2026-11-09 by bug-hunt final step (claude-cli)
- **Area:** `src/ui/webview-react/hooks/usePagedFileHistory.ts`
- **Severity:** low

## Symptom

582746374 says a paged git listing that the server expired (410) is recovered
while the list "keeps its length and scroll position". For file history the
list instead shrinks to two pages when recovery starts, the browser clamps
`scrollTop`, and the list then regrows one page at a time. The user's viewport
ends up pushed back to about row 2 × pageSize.

## Steps to Reproduce

1. File history with pageSize 3 and 30 entries; the fetcher reports totals the
   way the server does (`totalEntries: offset + entries.length`,
   `src/server/HostedWorkspaceViewerService.ts:2829`).
2. Scroll/load to row 17 (`totalCount` 21).
3. Make the listing answer 410 so recovery restarts it.
4. `totalCount` across renders: `21, 6, 9, 12, 15, 18, 21, 24`. It drops from 21 to 6.

The existing recovery test passes only because its `response()` helper
hard-codes `totalEntries = 10`, which the real server never sends for file
history.

## Root Cause

In `startListing`'s initial-page `.then` (`usePagedFileHistory.ts` ~325-342) the
recovery path does the same as a fresh load. It sets
`totalCount = max(totalEntries, 2 * pageSize)` and replaces `pages` with page 0
only, ignoring the length the list already had.

## Suggested Fix

When recovering (`recoveryTargetRef.current !== null`), keep
`totalCount: Math.max(current.totalCount, …)` and ideally keep the stale pages
past page 0 until the appends replace them. Add a recovery test whose fixture
reports totals the way the server does. The commit-history and ref-diff hooks
are unaffected because their server totals are real counts.
