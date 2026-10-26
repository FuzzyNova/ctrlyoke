# History short-page continuation sends unaligned commit offsets and stops after one page

- **Found:** 2026-10-25 by bug-drain review of cf3acdf4a
- **Area:** `src/ui/webview-react/hooks/usePagedCommitHistory.ts`, `src/ui/webview-react/hooks/usePagedFileHistory.ts`
- **Resolution:** fixed in this commit

## Symptom

cf3acdf4a (dev/bugs/implemented/file-history-range-change-leaves-short-page-gap.md) added a
"continue from `loadedCount`" request to both paged-history hooks. Two problems remain:

1. **Commit history can send an offset the server rejects.** The workspace commit log pages
   by aligned `skip` (`HostedWorkspaceViewerService` throws `skip must be aligned to
pageSize`), and its pages are always full except the last. But commit pages can load out
   of order, so `loadedCount` (the sum of loaded rows) is not where the loaded rows end.
   Example, pageSize 30, 1007 commits: drag to the bottom (loads page 990 with 17 rows and
   page 960, whose `hasMore: true` lands last), plus page 0 → `loadedCount` 77. Drag so the
   overscan covers row 77: `requestRange(77)` takes the `isContinuation` branch and issues a
   request at offset 77 → 400. That writes `failedRanges[77]`/`error`, which never clears
   because `retryPage(77)` is a no-op once page 60 covers row 77. Not visible in
   `WorkspaceCommitHistoryPane` today, but it is a wasted failing request and stale error
   state. The commit hook's "fills a short page" test asserts a request at offset 1, which
   the real server would reject, so it tests a case that cannot happen.
2. **File history fills only one short page.** The continuation is issued only from
   `onRangeChange`, which runs only when the range or `count` changes. If the first page has
   10 rows (`totalCount = max(entries, 60)`) and the continuation returns 5 rows with
   `hasMore`, `totalCount` stays 60 and the range is unchanged, so no new range event fires:
   rows 15–27 stay as loading spinners until the user scrolls. Same symptom, one page later.

## Root Cause

- `usePagedCommitHistory.ts`: `requestRange` (around lines 373–395) treats
  `requestedOffset === loadedCount` as a continuation and requests that raw offset;
  `onRangeChange` (around lines 578–594) calls `requestRange(loadedCount)`.
- `usePagedFileHistory.ts`: the continuation (around lines 589–605) only runs inside
  `onRangeChange`; the page `.then` only schedules a follow-up for zero-row pages.

## Suggested Fix

- Commit hook: remove the continuation path (pages are aligned and full); keep plain
  page-aligned requests. Replace the impossible "offset 1" test with one for the
  out-of-order scenario above asserting no unaligned request is sent.
- File hook: keep the last range in a ref; after a page returns fewer rows than requested
  but still `hasMore`, re-run the continuation if `virtualLengthRef.current` is inside that
  range. Keep the existing "cursor must advance" guard so it cannot loop; add a test that
  two consecutive short pages both get filled without a new range event, and a test that a
  page which does not advance the cursor is not re-requested forever.
- Share the `loadedCount` reduce via one helper instead of the copies in each hook.
