# Workspace Commit History Virtualization Plan

**Status:** Implemented
**Priority:** P3

Follow-on from
[`WORKSPACE_FILE_HISTORY_AND_IMAGE_DIFF_PLAN.md`](../implemented/WORKSPACE_FILE_HISTORY_AND_IMAGE_DIFF_PLAN.md)
§5, which deliberately left the repository-wide commit history pane
unvirtualized while adding a paged, virtualized file-history list
(`usePagedFileHistory` + `VirtualizedPagedList`, see
`src/ui/webview-react/hooks/usePagedFileHistory.ts` and
`src/ui/webview-react/components/diff/DiffFileHistoryList.tsx`). This plan
generalizes that paging/virtualization work to the pane it was deliberately
kept out of.

## Problem

`WorkspaceCommitHistoryPane` (rendered inside `WorkspaceSourceControlPane`)
renders the graph rail and commit rows eagerly from the full `commitHistory`
array in the store, with no virtualization. Initial load and every
`Load more…` click each fetch exactly 30 commits via `workspaceCommitLog`
(`WorkspaceSourceControlPane.tsx:155-177` for the initial `loadHistory`,
`:179-199` for `loadMoreHistory`, keyed off `commitHistory.length` as the
offset). On a long-lived repo with hundreds or thousands of commits, a user
who clicks "Load more" repeatedly ends up with every fetched commit mounted
as a full DOM row simultaneously — both the SVG graph elbow/lane segments in
`computeCommitGraphLayout` and the text row for each commit
(`WorkspaceCommitHistoryPane.tsx`).

This is exactly the DOM-scaling problem `VirtualizedPagedList` was built to
solve for file history, but the commit-graph pane has two properties file
history doesn't:

- The graph rail (an SVG rendering of lanes/elbows/merge lines via
  `computeCommitGraphLayout`, `WorkspaceCommitHistoryPane.tsx:10-60`) and the
  commit text rows must stay pixel-for-pixel vertically synchronized — they
  are two visual layers over the same row index, not one component.
- Lane colors and elbow continuity must read correctly across a scroll
  session, including at whatever window boundary a virtualizer introduces —
  a lane cannot visually "restart" just because its earlier rows scrolled out
  of the realized window.

## Design

1. **Extract the range/paging controller shape learned from file history.**
   `usePagedFileHistory`'s public shape — sparse page map, `totalCount`,
   generation guard, retryable page errors, `onRangeChange` driven by the
   virtualizer's overscan — is the concrete interface to mirror for commit
   history, replacing the current `loadHistory`/`loadMoreHistory` pair and
   the `commitHistory`/`commitHistoryHasMore` store fields with a paged
   equivalent (`usePagedCommitHistory` or similar). `workspaceCommitLog`
   already accepts an offset/limit pair, but as design point 2 below covers,
   the server contract does need a small extension (a frozen-snapshot
   `historyId`) for that pair to page safely.
2. **Freeze the commit log server-side before paging it, mirroring the
   `FileHistorySnapshot`/`historyId` mechanism `getFileHistory` already uses**
   (`HostedWorkspaceViewerService.ts:134-142, 1878-1898, 2008-2052`). This is
   a correctness requirement, not an optional hardening: `getCommitLog`
   currently re-runs a live `git log --skip=N -n limit` against the current
   ref on every call
   (`HostedWorkspaceViewerService.ts:2070-2141`,`getRecentCommits` in
   `GitUtils.ts:112-134`), with no snapshot. Design point 4 below relies on
   assembling a full, consistent commit array from many separately-fetched
   pages and feeding it through `computeCommitGraphLayout` as one top-to-
   bottom stateful fold. If a commit lands (or a checkout
   happens) between two page fetches, every offset after that point shifts;
   the concatenated array silently gains a duplicate or drops a commit, and
   the lane fold — which has no way to detect this — assigns wrong lanes and
   colors from that point down. File history solved exactly this problem for
   its own paging: `getFileHistory` fetches the complete unbounded log once
   (`getFileHistoryCommits(repoRoot, gitPath, undefined, 0, headHash)`),
   freezes it into an in-memory `FileHistorySnapshot` keyed by a server-issued
   `historyId`, and serves every subsequent page as a slice of that frozen
   array — see `materializeFileHistoryPage`, `createFileHistoryId`,
   `trimFileHistorySnapshots`/`FILE_HISTORY_SNAPSHOT_TTL_MS`/
   `FILE_HISTORY_SNAPSHOT_MAX_COUNT` for the eviction policy to mirror.
   Repo-wide history has no path filter, so an unbounded `git log` is a larger
   fetch than a single file's — acceptable given the acceptance criteria's own
   scale ("hundreds or thousands of commits", not monorepo-scale histories),
   consistent with the precedent this plan is mirroring; note the TTL/count
   eviction already bounds how many snapshots can be held at once. Concretely,
   this needs: (a) `getRecentCommits` (`GitUtils.ts:112-134`) to accept an
   `undefined` limit for an unbounded fetch, matching
   `getFileHistoryCommits`'s existing `limit: number | undefined` signature;
   (b) a new frozen-snapshot response shape for commit log paging (add fields
   to `WorkspaceCommitLogResponse` or introduce a
   `WorkspaceCommitLogPageResponse` paralleling
   `WorkspaceFileHistoryPageResponse`) carrying `historyId`, `pageSize`,
   `totalEntries`/`offset`; (c) `getCommitLog` gaining a `historyId` parameter
   with the same validate-and-slice-or-refetch flow as `getFileHistory`,
   keying the snapshot on `(repoRoot, branchHint, detached)` the way file
   history keys on `(repoRoot, requestedPath)`; (d) `workspaceCommitLog` in
   `hostedApi.ts` (`:271-284`) and the `/api/workspace-viewer/commit-log`
   route passing `historyId` through. Consider extracting a small shared
   generic snapshot-cache helper (id issuance, TTL/count eviction, slice
   materialization) that both `getFileHistory` and `getCommitLog` call into,
   per this project's DRY/single-source convention — but only if it stays
   simple; do not force a shared abstraction that makes either call site
   harder to follow. This is the step that should land first, since the new
   `usePagedCommitHistory` hook (design point 1) is written against this
   response shape.
3. **Virtualize one shared row range for both layers.** Do not virtualize the
   SVG rail and the text rows independently — a single `VirtualizedPagedList`
   (or equivalent range controller) must drive both, so a graph elbow and its
   commit's text row are always realized or unrealized together. The SVG
   layer likely needs to render as one tall absolutely-positioned surface
   spanning the realized window (translated per-row), not one `<svg>` per
   row, to keep elbow paths that span multiple rows (merges, long-running
   lanes) drawable without clipping at row boundaries.
4. **Preserve graph lane continuity at loaded-window boundaries.** A lane's
   color and horizontal position are derived from `computeCommitGraphLayout`
   over the commits it has seen; feeding it a windowed subset instead of the
   full fetched history risks lane reassignment/color drift as the window
   slides. This needs either (a) running layout over the full fetched
   (not just realized) commit set and only virtualizing the row _rendering_,
   or (b) extending `computeCommitGraphLayout` to accept and preserve
   in-flight lane state across windowed calls. Prefer (a) unless memory
   profiling on a large history shows the full-layout array itself is the
   bottleneck — it is simpler and avoids a second, harder layout algorithm.
5. **Replace the manual `Load more…` button with overscan-driven loading**
   (`WorkspaceCommitHistoryPane.tsx:553-565`), matching how
   `usePagedFileHistory`'s `onRangeChange` requests only the pages needed to
   cover the visible/overscan range — while retaining every other piece of
   existing pane behavior: refresh, detached-HEAD branch hints
   (`detachedBranchHint()` in `WorkspaceSourceControlPane.tsx`), checkout
   actions (`workspaceCheckoutBranch`), and the existing commit-history
   context menu (`useCommitHistoryContextMenu`).

## Implementation status

- [x] Design point 1: `usePagedCommitHistory` owns sparse pages, frozen-list
      identity, loading/error state, refresh, and overscan range requests.
- [x] Design point 2: commit-log pages use a server-side frozen snapshot.
- [x] Design point 3: one virtualized row range drives both the graph rail and
      commit text rows.
- [x] Design point 4: graph layout is folded over the loaded contiguous prefix
      before only the realized rows are rendered. A sparse page beyond a gap stays
      a placeholder until the gap is filled, preserving lane continuity without
      assigning layout state to an incomplete sequence.
- [x] Design point 5: `WorkspaceSourceControlPane` owns the paging controller,
      passes it to both desktop and mobile panes, and all refresh/mutation flows
      refresh the controller. There is no manual load-more action.

The store no longer caches commit rows or paging/loading flags. It retains only
current-branch and detached-HEAD metadata for the checkout context menu; the
history hook is the source of truth for rows and loading state. The diff
download path uses `diffCommitInfo.hash`, so it remains correct when the
selected commit is outside the realized history window. `useCommitHistoryContextMenu`
was verified to receive and act on the commit object itself, with no row-index
lookup, so windowing does not change commit resolution.

## Non-goals

- **Directory history is not part of this plan.** Viewing commit history
  scoped to a directory (rather than a single file, which the base plan
  already shipped, or the whole repo, which this plan virtualizes) is a
  distinct feature — path-scoped log plumbing exists in `GitUtils.ts` from
  the file-history work, but the UI entry point, pagination contract, and
  directory-vs-file semantics are undesigned. Track it separately if it
  becomes a real need.
- This plan does not add a new endpoint — `getCommitLog`/`workspaceCommitLog`/
  `/api/workspace-viewer/commit-log` are extended in place (a `historyId`
  parameter and a frozen-snapshot response, per design point 2), not
  replaced. The offset/limit shape callers pass is otherwise unchanged.
- No change to `DiffFileList`/`VirtualizedList` (the dense text-diff list) —
  see `GIT_REF_DIFF_PAGINATION_PLAN.md` for that follow-on instead.

## Likely implementation surface

- `src/server/HostedWorkspaceViewerService.ts` — add a `CommitLogSnapshot`
  (mirroring `FileHistorySnapshot`, `:134-142`) and give `getCommitLog`
  (`:2070-2141`) the same historyId validate-and-slice-or-refetch flow as
  `getFileHistory` (`:1783-1899`), including TTL/count eviction mirroring
  `FILE_HISTORY_SNAPSHOT_TTL_MS`/`FILE_HISTORY_SNAPSHOT_MAX_COUNT`
  (`:2008-2052`).
- `src/utils/GitUtils.ts` — give `getRecentCommits` (`:112-134`) an
  `undefined`-limit unbounded mode, matching `getFileHistoryCommits`'s
  existing `limit: number | undefined` signature (`:188-213`).
- `src/types/HostedWorkspaceViewerTypes.ts` — extend
  `WorkspaceCommitLogResponse` or add a `WorkspaceCommitLogPageResponse`
  (`:332-338`) carrying `historyId`/`pageSize`/`totalEntries`/`offset`,
  paralleling `WorkspaceFileHistoryPageResponse` (`:353-363`).
- `src/ui/webview-react/utils/hostedApi.ts` — thread `historyId` through
  `workspaceCommitLog` (`:271-284`), matching `workspaceFileHistory`'s
  existing shape.
- `src/ui/webview-react/components/workspace-viewer/WorkspaceCommitHistoryPane.tsx`
  — replace eager full-array rendering with a windowed render driven by the
  new paged controller; rework the SVG rail to render per realized window
  rather than per full array.
- `src/ui/webview-react/components/workspace-viewer/WorkspaceSourceControlPane.tsx`
  — replace `loadHistory`/`loadMoreHistory` (`:155-199`) with the new paged
  hook; remove the `Load more…` click handler in favor of `onRangeChange`.
- `src/ui/webview-react/store/workspaceViewerStore.ts` — replace or wrap the
  `commitHistory`/`commitHistoryHasMore`/`setCommitHistory`/
  `appendCommitHistory` fields with whatever shape the new paged controller
  needs (likely keeping the store as a thin cache and moving paging state
  into the hook, matching `usePagedFileHistory`'s split).
- `src/ui/webview-react/hooks/usePagedFileHistory.ts` — reference pattern
  only; a new sibling hook is expected rather than a direct reuse, since
  commit history has no per-path scoping and needs branch/detached-HEAD
  awareness `usePagedFileHistory` doesn't.
- `src/utils/commitGraphLayout.ts` (`computeCommitGraphLayout`) — likely
  needs a windowed-rendering-aware entry point if full-array layout proves
  too expensive at very large history sizes; start without this change and
  add it only if profiling shows a real need.
- `src/ui/webview-react/hooks/useCommitHistoryContextMenu.ts` — verify it
  still resolves the correct commit against windowed/virtualized rows.

## Testing plan

- Snapshot/staleness tests: a commit landing (or a checkout) between two page
  fetches does not corrupt an in-progress paged listing — the stale
  `historyId` either keeps serving its frozen view consistently or is
  rejected and the hook re-freezes cleanly (mirroring how
  `usePagedFileHistory`/`getFileHistory` handle an expired/mismatched
  `historyId`), never a silently shifted or duplicated page.
- Paging/virtualization tests: only the initial visible/overscan range is
  requested on open; scrolling requests older pages; sparse placeholder rows
  render without breaking `aria-posinset`-style indexing (mirroring the
  file-history placeholder-row tests from the base plan).
- Graph continuity tests: lane color and elbow position for a commit are
  identical whether or not it was previously scrolled out of the realized
  window and back into view; a merge commit's elbow renders correctly when
  its parent row is outside the current realized window.
- Regression tests: refresh, detached-HEAD branch hint rendering, checkout
  actions, and the commit context menu all continue to work against the
  windowed pane.
- Performance sanity check on a large real-world history (hundreds+ commits,
  several branches) — DOM node count should stay bounded by the realized
  window, not the total commit count.

Manual performance verification remains outstanding: Playwright tooling was
not attached for this implementation turn, so the dev-host check should be
run manually against a large repository history.

## Acceptance criteria

- Scrolling a long commit history no longer accumulates one full-height DOM
  row (graph + text) per loaded commit; only the realized window plus
  overscan is mounted at any time.
- Graph lane colors and elbow continuity are visually unchanged from today's
  eager rendering, including at whatever boundary the realized window
  introduces during a scroll session.
- `Load more…` is replaced by overscan-driven loading with no behavior
  regression in refresh, detached-HEAD hints, checkout, or context menus.
- Directory history remains explicitly out of scope.
