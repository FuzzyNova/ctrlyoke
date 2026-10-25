# File history rows after a short first page stay as spinners until the user scrolls

- **Found:** 2026-10-25 by bug-drain review of 90f508194
- **Area:** `src/ui/webview-react/hooks/usePagedFileHistory.ts` (`onRangeChange`, `requestRange`), `src/ui/webview-react/components/workspace-viewer/DiffFileHistoryList.tsx`
- **Resolution:** fixed in this commit

## Symptom

90f508194 was meant to fill the loading rows that follow a short file-history page
(rows filtered out by trusted roots, or a page cut by the server deadline, with
`hasMore: true`). Retry at an unaligned offset now works, but the main scenario is not
fixed through the real component: on first load, the rows between the short page's end
and the end of the viewport stay as spinners until the user scrolls.

## Steps to Reproduce

1. Open file history for a file whose first page (pageSize 30) comes back with 10 rows
   and `hasMore: true`.
2. The list renders rows 0–9 plus loading rows up to about row 27 (overscan is 12).
3. Nothing is requested for rows 10–27 until a scroll changes the range.

## Root Cause

`DiffFileHistoryList` drives loading only through `onRangeChange`
(`usePagedFileHistory.ts` around lines 559–581), which still rounds offsets down to page
boundaries with `pageOffset(...)`. On load it calls `requestRange(0)`; because
`0 < loadedCount` (10), `requestRange` returns early. The new tests in
`src/ui/webview-react/test/hooks/usePagedFileHistory.test.ts` call `requestRange(1)` (an
unaligned offset) directly and never go through `onRangeChange`, so they pass.

`usePagedCommitHistory.ts` received the same unaligned-offset handling; it is unused today
because `materializeCommitLogPage` never returns a short page with `hasMore`, but it has
the same `onRangeChange` rounding and should be kept consistent.

## Suggested Fix

In `onRangeChange`, after the page-aligned requests, also request from the first unloaded
row inside the visible/overscan range (`loadedCount` when it lies inside the range), without
rounding — `requestRange` already continues from the server's `nextCursor`/`nextOffset`.
Make sure this does not issue a duplicate request while one is in flight and does not loop
when a page returns zero rows with `hasMore` (the existing "cursor must advance" guard
should cover that; assert it). Apply the same to `usePagedCommitHistory`.

Add a hook test that goes through `onRangeChange` (short first page, then a range-change
covering rows past it → the next page is fetched without scrolling), and one through
`DiffFileHistoryList` if its test harness allows.
