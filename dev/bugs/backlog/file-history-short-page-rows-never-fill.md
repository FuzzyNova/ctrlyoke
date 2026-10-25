# File history rows after a short page stay as spinners, and Retry does nothing

- **Found:** 2026-10-25 by bug-drain review of cd7749ebc
- **Area:** `src/ui/webview-react/hooks/usePagedFileHistory.ts`, `src/ui/webview-react/components/workspace-viewer/DiffFileHistoryList.tsx`
- **Severity:** high

## Symptom

When a file-history page comes back short (trusted-root filtering drops rows, or the
server deadline cuts the page) with `hasMore: true`, the rows after it render as
loading placeholders that never fill while they are in view. The error row's "Retry
page" button does nothing either. Only scrolling further down triggers a fetch.

## Steps to Reproduce

1. pageSize 30. Page 0 returns 10 rows with `hasMore: true`, so `totalCount` becomes 60.
2. The viewport shows rows 0 to about 20; `onRangeChange` requests offset 0 only.
3. Rows 10-29 stay as spinners.
4. With a failed page at an unaligned offset (e.g. 37), clicking Retry has no effect.

## Root Cause

In `usePagedFileHistory.ts` `requestRange`, the requested offset is aligned with
`targetOffset = pageOffset(requested)` and then dropped by
`if (targetOffset < loadedCount) return;`. When `loadedCount` is not on a page
boundary, a request for the page holding the first unloaded row is ignored.
`failedRanges` is keyed by the unaligned `loadedCount` (e.g. 37), and
`DiffFileHistoryList.tsx` (around line 195) calls `retryPage(37)`, which aligns to 30
and returns early for the same reason.

The hook test added in cd7749ebc only uses an aligned request (`requestRange(3)`,
pageSize 3).

## Suggested Fix

Fetches are sequential continuations (the server pages by cursor), so drop the page
alignment for the "next fetch" decision: if any requested row index is at or beyond
`loadedCount` and below `totalCount`, fetch the next continuation from `loadedCount`.
Make retry re-issue the continuation for the failed offset. Check
`usePagedCommitHistory.ts` for the same pattern and fix it there too if present.
Tests (must fail on current code): short first page followed by a request inside the
first page window fills the gap; retry at an unaligned failed offset re-fetches.
