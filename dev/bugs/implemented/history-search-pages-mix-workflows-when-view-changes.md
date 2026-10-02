# History search ("this workflow only") can merge later pages from a different workflow

- **Found:** 2026-09-30 by the bug-backlog workflow final step (claude-cli); traced in code, not reproduced
- **Area:** `src/ui/webview-react/components/search/HistorySearchDrawer.tsx` (page 0 ~268 vs `requestPage` ~490, `listingId` ~450), `src/ui/webview-react/hooks/useMessageHandler.ts` (~2757)
- **Resolution:** fixed in this commit

## Symptom

With "this workflow only" on, page 0 is requested with the workflow key captured
when the search was issued (deliberately, so background view changes don't
re-issue it). Later pages use the *current* `workflowKey`. If the displayed
workflow changes in the background, the requested-page set resets (the key is
part of `listingId`) but page 0 stays on screen. Scrolling then merges workflow
B's results at offsets ≥ page size into workflow A's list. The result handler only
checks the query, so nothing rejects these pages.

## Suggested Fix

Store the workflow key used for page 0 with the listing and reuse it for every
page. Alternatively, deliberately re-issue page 0 when the key changes while
workflow-only is on. Reject result pages whose scope doesn't match the listing.
