# History Search Drawer Virtualization & Position Retention Plan

**Status:** Proposed
**Priority:** P3

Sibling to
[`WORKSPACE_COMMIT_HISTORY_VIRTUALIZATION_PLAN.md`](WORKSPACE_COMMIT_HISTORY_VIRTUALIZATION_PLAN.md),
which generalizes the paged/virtualized-list pattern from
`usePagedFileHistory` + `VirtualizedPagedList` to the workspace commit-graph
pane. This plan applies the same pattern to `HistorySearchDrawer`
(`src/ui/webview-react/components/search/HistorySearchDrawer.tsx`), which has
a materially simpler rendering problem (homogeneous result rows, no
graph-rail sync) but a materially different pagination contract (sequential
opaque cursor, not offset/limit).

## Problem

Two distinct complaints prompted this plan:

1. **"Back to results" loses your place.** After clicking a result
   (`navigateToResult`, `HistorySearchDrawer.tsx:249-280`), the only way back
   is to reopen the drawer via the search button. Reopening does *not*
   actually resume where you left off — it silently re-runs the search from
   scratch and drops any list scroll position.
2. **Results are not virtualized.** `results.map(...)`
   (`HistorySearchDrawer.tsx:646-690`) renders every fetched result as a full
   DOM row unconditionally. Each `Load more` click
   (`HistorySearchDrawer.tsx:364-393`) appends another `RESULT_LIMIT` (50)
   rows on top, so a long session of "Load more" clicks accumulates
   unbounded DOM nodes, same shape of problem as the commit-history pane.

### Root cause of (1) is not unmounting — it's a stale-effect reset

Unlike the workspace-viewer modal (fixed separately, see git history), this
drawer is **already** always-mounted: `App.tsx:978` and `App.tsx:1247` render
`<HistorySearchDrawer />` unconditionally in both the desktop and mobile
layout trees, and visibility is purely a CSS transform/`pointer-events`
toggle (`HistorySearchDrawer.tsx:414-417`). So component state (scroll
position, DOM) is not destroyed by closing/reopening.

The actual bug is the debounced-search effect:

```tsx
// HistorySearchDrawer.tsx:227-247
useEffect(() => {
  if (!isOpen) return;
  if (trimmedQuery.length < 2) { ...clear results... ; return; }
  const timeoutId = window.setTimeout(() => {
    issueSearch(filtersRef.current);
  }, 400);
  return () => window.clearTimeout(timeoutId);
}, [isOpen, issueSearch, query, setHistorySearchResults, trimmedQuery]);
```

`isOpen` is in the dependency array. Every reopen (`isOpen` false→true) reruns
this effect even though `query` hasn't changed, and `issueSearch` itself
starts by clearing the list (`setHistorySearchResults([], true, ...)`,
`HistorySearchDrawer.tsx:204-208`) before re-fetching page 1. So reopening
always wipes the results (and any extra pages loaded via "Load more") and
restarts the loading spinner — that's what reads as "lost your position",
even though the scroll container itself was never unmounted.

## Design

### Phase 0 — quick win: stop clearing an unchanged search on reopen

Split "the query/filters changed, need a fresh search" from "the drawer
became visible again." Concretely: key the debounced-search effect off
`trimmedQuery` and `historySearchFilters` only, and use a separate effect
(or a ref-guarded check inside the existing one) for the focus/select-on-open
behavior (`HistorySearchDrawer.tsx:219-225`), which should keep running on
every open. When the drawer reopens with the same query and existing
results, do nothing — the already-mounted list, its scroll position, and
`results`/`totalCount`/`nextCursor` state in the store all fall out for
free, the same way the workspace-viewer modal fix got scroll/preview state
for free once it stayed mounted.

This alone resolves complaint (1) without touching virtualization, and is
low-risk enough to ship independently of Phase 1.

### Phase 1 — virtualize + overscan-driven infinite scroll

Once Phase 0 is in, replace the eager `results.map()` render and the manual
`Load more` button with `VirtualizedPagedList` (or a thin wrapper), driven by
`onRangeChange` the same way `usePagedFileHistory` drives file-history
paging. This pane is simpler than the commit-history case: there is no
second synchronized visual layer (no graph rail), so a straight
`VirtualizedPagedList<HistorySearchResult>` swap over the existing card
markup (`HistorySearchDrawer.tsx:653-689`) should suffice — no bespoke
range-controller design needed on the rendering side.

**Where this differs from both `usePagedFileHistory` and the planned
`usePagedCommitHistory`:** those wrap `workspaceCommitLog`-style
**offset/limit** APIs, which support true random access — any page can be
requested or retried independently by index, which is exactly what
`VirtualizedPagedList.getItem(index)` assumes. `SEARCH_HISTORY` instead
returns an opaque `cursor` for **sequential** paging only — confirmed in
`HistorySearchIndexService.ts:669-681`, where the cursor is a base64-encoded
offset that the client is not meant to construct itself, and
`WebviewMessageRouter.ts:1199-1235`, which just forwards whatever cursor the
client last received. There is no "give me results 400-450" call today.

Recommended approach: don't build a random-access page map. Search results
are consumed top-to-bottom (ranked/time-ordered), not jumped into at an
arbitrary offset the way a user might scrub a commit graph — so a simpler
**sequential windowed loader** is sufficient: keep a flat, ever-growing
`results` array (as today), and use `onRangeChange`'s overscan signal purely
as the trigger to call `loadMore()` when the realized window approaches the
end of what's loaded, instead of requiring a manual button click. This keeps
the existing cursor/`hasMore` contract in the store untouched
(`historySearchNextCursor`, `historySearchHasMore` in `uiStore.ts`) — only
the trigger for "fetch the next page" changes, from a click handler to a
range-change callback. No server contract change needed.

If a future need for arbitrary-offset access to search results emerges
(e.g. "jump to result #500"), that would require extending
`HistorySearchIndexService.search` with an explicit offset parameter — track
that separately if it becomes a real need; today's UI never asks for it.

### Sequencing

Phase 0 and Phase 1 are independent and can ship separately: Phase 0 is a
small, low-risk bug fix; Phase 1 is a rendering/pagination-trigger swap that
depends on Phase 0 already being correct (no point virtualizing a list that
gets thrown away on every reopen).

## Non-goals

- No change to `SEARCH_HISTORY`'s server contract or `HistorySearchIndexService`'s
  cursor shape — this plan works within the existing sequential-cursor API.
- No random-access "jump to page N" support for search results (see above).
- No change to the filter drawer (`filtersOpen` UI, `MultiCheckboxDropdown`
  filters) beyond whatever `useEffect` dependency changes Phase 0 requires.
- Does not touch `WorkspaceSearchPane` (a different, workspace-file-content
  search feature that already reuses `HistorySearchDrawer`'s debounce
  pattern per `dev/implemented/WORKSPACE_SEARCH_PLAN.md` but has its own
  component and store state).

## Likely implementation surface

- `src/ui/webview-react/components/search/HistorySearchDrawer.tsx` —
  Phase 0: split the reopen-focus effect from the search-trigger effect.
  Phase 1: replace `results.map()` (`:646-690`) and the `Load more` button
  (`:692-704`) with `VirtualizedPagedList` + `onRangeChange`-triggered
  `loadMore()`.
- `src/ui/webview-react/store/uiStore.ts` — `historySearchResults`,
  `historySearchNextCursor`, `historySearchHasMore`,
  `setHistorySearchResults` likely need no shape change for Phase 1 (the
  sequential model keeps a flat array), but verify `append` semantics
  (`HistorySearchDrawer.tsx:369` `append: true`) stay correct when triggered
  from range-change instead of a click.
- `src/ui/webview-react/components/shared/VirtualizedPagedList.tsx` —
  reused as-is (index-based `getItem`, `onRangeChange`); confirm its overscan
  defaults are reasonable for a sequential-only backing list (no independent
  per-page retry needed here, unlike file/commit history's sparse page map).
- `src/ui/webview-react/test/components/search/HistorySearchDrawer.test.tsx`
  — currently 0% covered per `dev/backlog/TESTING_GAPS.md:85`; both phases
  should land with real coverage, not just avoid regressing an already-empty
  suite.

## Testing plan

- Phase 0: reopening the drawer with an unchanged query does not clear
  `historySearchResults` or reset `historySearchNextCursor`/`hasMore`; the
  focus/select-on-open behavior still fires every time the drawer opens;
  changing the query or a filter still triggers a fresh debounced search.
- Phase 1: scrolling near the end of the realized window with `hasMore: true`
  triggers exactly one `loadMore()` call (no duplicate fetches from overlapping
  range-change events); the manual `Load more` button is gone; placeholder
  rows render correctly for not-yet-loaded trailing indices if the
  virtualized list renders ahead of fetch completion.
- Regression: `navigateToResult` → back via the search button still shows the
  previously-scrolled-to result in view, not the top of the list.

## Acceptance criteria

- Reopening the search drawer after navigating to a result resumes at the
  same scroll position with the same results already populated, with no
  redundant re-search when the query is unchanged.
- Search result DOM node count stays bounded by the realized virtualized
  window, not the total number of results loaded across a session.
- `Load more` is replaced by overscan-driven sequential loading with no
  behavior regression in filters, date-range scoping, or `Escape`-to-close.
- No server-side pagination contract change required.
