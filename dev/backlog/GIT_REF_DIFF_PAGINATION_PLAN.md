# Paginate Large Commit/Ref Diffs Plan

**Status:** Proposed
**Priority:** P3

Follow-on from
[`WORKSPACE_FILE_HISTORY_AND_IMAGE_DIFF_PLAN.md`](../implemented/WORKSPACE_FILE_HISTORY_AND_IMAGE_DIFF_PLAN.md)
§6, which explicitly named large-commit scalability as out of scope rather
than letting it be silently expanded into while adding image-diff support.
That plan added base64-encoded image bytes to `getGitRefDiff`'s response
(`nonTextEntries`, see `HostedWorkspaceViewerService.ts:2301-2394`), which
makes an already-unbounded single-shot payload larger for large commits (for
example, a repo-wide `npm run format`, or a commit touching several images).
This plan is the deferred fix: give `getGitRefDiff` a paginated,
structured-entry server contract instead of returning one unbounded diff
blob.

## Problem

`getGitRefDiff`/`getCommitDiff` fetch an entire commit's diff in one git
invocation and return it in one HTTP response today
(`HostedWorkspaceViewerService.ts:2301-2394`, delegating to `getCommitDiff`
in `src/utils/GitUtils.ts`). `DiffFileList`'s `VirtualizedList`-based
virtualization (`DiffFileList.tsx`, threshold
`DIFF_FILE_LIST_VIRTUALIZATION_THRESHOLD = 30`, `:41`) is a DOM rendering
optimization only — it reduces mounted nodes, not network payload size or
server-side memory/CPU. Every file in a large commit is still parsed,
transferred, and held in memory before the first row ever renders.

Two concrete costs from this:

- **Response size and latency.** A large commit's `unifiedDiff` string plus
  (since the base plan shipped) base64-encoded image bytes in
  `nonTextEntries` scale with the whole commit, not with what the user can
  see on screen. Time-to-first-render is gated on the full payload arriving
  and being parsed client-side by `parseUnifiedDiffToFiles`.
- **A real (if non-silent) failure mode.** `GitUtils.ts`'s `execFile` wrapper
  overflowing its `maxBuffer` (`GIT_MAX_BUFFER = 50 * 1024 * 1024`,
  `GitUtils.ts:8`) throws `ERR_CHILD_PROCESS_STDOUT_MAXBUFFER`, which
  hard-fails the entire commit view rather than truncating it. There is
  already a per-call-site precedent for raising the cap
  (`getGitTrackedFiles` overrides to 500MB for large monorepos,
  `GitUtils.ts:732`), but raising the cap only delays the failure — it does
  nothing for response latency, peak memory, or the additional inflation
  from base64 image bytes.

## Design

Generalize the paged list component the file-history work already built —
`VirtualizedPagedList` with one `DiffFileCard` per realized row
(`src/ui/webview-react/components/diff/DiffFileHistoryList.tsx` and
`src/ui/webview-react/hooks/usePagedFileHistory.ts` are the concrete
reference implementations) — so `WorkspaceDiffPane`'s commit/ref diff view
uses the same pattern instead of `DiffFileList`'s dense, fully-realized
`VirtualizedList`.

Give `getGitRefDiff` a paginated, structured-entry server contract:

- A frozen-at-open snapshot paged by `offset`/`pageSize`, the same shape as
  the file-history design (`WORKSPACE_FILE_HISTORY_AND_IMAGE_DIFF_PLAN.md`
  §2: a server-generated id bound to a snapshot, rejecting
  misaligned/out-of-bounds page requests). A commit's file list and diff
  content do not change once the commit is fixed, so "frozen at open" here
  is actually simpler than the file-history case — there is no analog to new
  commits landing mid-scroll, since the ref/hash is already fixed by the
  time this endpoint is called.
- Each page returns structured per-file entries in the same
  text-or-image-or-binary shape `nonTextEntries`/the base plan's Design §4
  already established, not raw diff text — so `DiffFileCard`'s existing
  `hunks`/`content`/`patch`/`image`/binary-fallback source union can consume
  a page directly without a second parsing path.
- **Keep the existing single-shot `unifiedDiff` string response only for the
  explicit Download action**, which legitimately needs the whole file and is
  not latency-sensitive the way an initial render is. Do not remove or page
  that code path — add the paged, structured contract alongside it.

## Non-goals

- **`DiffFileList` itself is not retrofitted into a paged component.**
  `DiffFileList` has exactly two production consumers: `WorkspaceDiffPane`
  (network-backed, no selection UI — the one this plan repoints to the new
  paged list) and `UndoChangesDialog`
  (`src/ui/webview-react/components/output/UndoChangesDialog.tsx`). The
  latter's checkbox multi-select, "N of M selected"/select-all, and bulk
  undo/redo submit all require the complete checkable row set to be known
  synchronously — that need is what keeps `DiffFileList` dense, and is not
  an accident of panel-vs-hosted-dashboard rendering. `DiffFileList` stays
  exactly as it is for `UndoChangesDialog`; only `WorkspaceDiffPane` moves
  to the new paged list.
- This plan does not change the file-history endpoints (`file-history`,
  `file-history-diff`) — they already ship the paginated, structured contract
  this plan is extending to commit/ref diffs.
- Raising `GIT_MAX_BUFFER` further is not a substitute for this plan and is
  out of scope here — pagination is the actual fix; a higher cap only delays
  the same failure at a larger commit size.

## Likely implementation surface

### Contracts and server

- `src/types/HostedWorkspaceViewerTypes.ts` — new paginated
  `WorkspaceGitRefDiffResponse` page contract (or a parallel paged
  type/endpoint alongside the existing single-shot one), reusing the
  text-or-image-or-binary structured-entry shape already defined for
  `nonTextEntries`/file-history.
- `src/server/CtrlYokeHostedServer.ts` — new paged route (or extend the
  existing `git-ref-diff` route with `offset`/`pageSize` query params),
  following the thin-handler pattern already used for `file-history`/
  `file-history-diff`.
- `src/server/HostedWorkspaceViewerService.ts` — extend or wrap
  `getGitRefDiff` (`:2301-2394`) with a snapshot/pagination layer modeled on
  `WorkspaceListingSnapshotCache`, matching how file history's snapshot
  approach was built.
- `src/utils/GitUtils.ts` — `getCommitDiff` and the diff-source helpers used
  by `getGitRefDiff` may need a per-file or chunked git invocation path
  rather than one `git show`/`git diff` covering every file, if avoiding the
  `maxBuffer` failure mode entirely (not just paginating the _response_) is
  in scope — confirm this against real large-commit profiling before
  committing to a specific git invocation shape.

### Client

- `src/ui/webview-react/utils/hostedApi.ts` — new paged fetch helper,
  patterned after the file-history fetcher.
- `src/ui/webview-react/hooks/usePagedFileHistory.ts` — reference pattern;
  a new sibling hook (e.g. `usePagedGitRefDiff`) is expected rather than
  direct reuse, since it's scoped by ref/hash instead of path.
- `src/ui/webview-react/components/diff/DiffFileHistoryList.tsx` — reference
  pattern for a new `DiffFileList`-replacement component in
  `WorkspaceDiffPane`'s commit/ref view, built on `VirtualizedPagedList`.
- `src/ui/webview-react/components/workspace-viewer/WorkspaceDiffPane.tsx` —
  swap the commit/ref (`commitGroups`) diff rendering path to the new paged
  list; the single working-tree file diff (`singleFileGroups`) is unaffected
  since it was never the unbounded-payload case.
- Retain the existing Download action's use of the single-shot `unifiedDiff`
  string unchanged.

## Testing plan

- Service tests: paged commit/ref diff snapshot pagination (stable
  continuation id, misaligned/out-of-bounds rejection, mirroring the
  file-history snapshot tests), a large-commit fixture that would overflow
  the default `maxBuffer` if not paginated correctly, and parity of
  structured entries (text/image/binary) between the new paged contract and
  the existing `nonTextEntries` shape.
- Paging/virtualization tests: only the initial visible/overscan pages are
  requested on opening a large commit; scrolling requests further pages;
  page failures are retryable; the commit/ref list renders through
  `VirtualizedPagedList`, not `DiffFileList`.
- `WorkspaceDiffPane` tests: Download action still returns the full
  single-shot `unifiedDiff`; existing expand/collapse-all, image rendering,
  and binary fallback behavior is unchanged under the new paged source;
  `UndoChangesDialog`'s use of `DiffFileList` is unaffected (regression
  check that its checkbox/select-all/bulk-undo behavior still works against
  the untouched dense list).
- Performance sanity check: a large real-world commit (e.g. a repo-wide
  formatting commit) opens without a `maxBuffer` failure and without
  transferring/parsing the full diff before first render.

## Acceptance criteria

- Opening a large commit/ref diff in `WorkspaceDiffPane` no longer requires
  fetching and parsing the entire commit's diff before the first file
  renders; only the visible/overscan range is fetched.
- A commit large enough to previously risk `ERR_CHILD_PROCESS_STDOUT_MAXBUFFER`
  opens successfully via the paged contract.
- The Download action continues to return the complete unified diff exactly
  as before.
- `DiffFileList` and `UndoChangesDialog`'s bulk undo/redo behavior are
  unmodified by this plan.
