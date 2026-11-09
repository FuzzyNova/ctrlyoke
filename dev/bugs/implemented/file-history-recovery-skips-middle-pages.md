# Recovering an expired file-history listing duplicates rows and never reloads the middle pages

- **Found:** 2026-11-09 by bug-hunt final step (claude-cli subagent, failing Vitest repro)
- **Area:** `src/ui/webview-react/hooks/usePagedFileHistory.ts`
- **Resolution:** fixed in this commit

## Symptom

When a file-history listing expires (the server answers 410) after **more than one page** has
loaded, recovery fetches the new listing's page 0 and then skips straight to the old end of the
list. The rows between page 0 and the old end are never fetched from the new listing; the next
page is placed at the old end with page 0's cursor, so the server walks from page 0 and the list
shows page 1's commits twice (once stale, once at the wrong offset).

## Steps to Reproduce

`pageSize` 3, 10 history entries, a mock that walks by `nextOffset` the way
`HostedWorkspaceViewerService.materializeFileHistoryPage` (~2728-2739) does:

1. Load page 0 and page 3 from listing A.
2. Listing A starts answering 410; `requestRange(6)` triggers recovery.
3. Listing B answers page 0 with `nextOffset: 3`.

- **Expected:** listing B is asked for offsets 3, then 6.
- **Actual:** it is asked only for offset 6; rows 0-8 read
  `hash-0..5, hash-3, hash-4, hash-5`.

The existing "expired listings" tests in
`src/ui/webview-react/test/hooks/usePagedFileHistory.test.ts` only expire the listing after page 0,
so they miss this.

## Root Cause

Regression from 3a6bc6f76 (`fix: preserve file history length during recovery`). The recovery
first-page handler (~334) keeps the dead listing's pages
(`pages = isRecovery ? new Map(current.pages) : new Map()`) so the list does not shrink, but
`virtualLengthRef` and the cursor refs are reset to the new page 0. `requestRange` (~413-418) then
computes the next offset as `loadedRowCount(current.pages, virtualLengthRef.current)`, which counts
the stale pages too. `requestRange(pageSize)` is dropped (`targetOffset < loadedCount`), and the
next append goes out at the old row count carrying page 0's cursor.

## Suggested Fix

While a listing is being recovered, derive the append offset from the new listing's contiguous
length (`virtualLengthRef.current`), not from the summed pages, or keep the stale rows in a
separate display-only map that `loadedRowCount` ignores. Keep the 3a6bc6f76 behaviour (length and
visible rows preserved during recovery). Add a test that loads several pages before the 410 and
asserts the requested offsets and the final row order.
