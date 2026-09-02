# Paginate Large Commit/Ref Diffs Plan

**Status:** Implemented

Shipped: paged git-ref-diff server/client plumbing is now wired into the live workspace diff pane, with full unified-diff downloads retained.
**Priority:** P3

Follow-on from
[`WORKSPACE_FILE_HISTORY_AND_IMAGE_DIFF_PLAN.md`](./WORKSPACE_FILE_HISTORY_AND_IMAGE_DIFF_PLAN.md)
§6, which explicitly named large-commit scalability as out of scope rather
than letting it be silently expanded into while adding image-diff support.
That plan added base64-encoded image bytes to `getGitRefDiff`'s response
(`nonTextEntries`, see `HostedWorkspaceViewerService.ts:2368-2434`), which
makes an already-unbounded single-shot payload larger for large commits (for
example, a repo-wide `npm run format`, or a commit touching several images).
This plan is the deferred fix: give `getGitRefDiff` a paginated,
structured-entry server contract instead of returning one unbounded diff
blob.

## Problem

`getGitRefDiff`/`getCommitDiff` fetch an entire commit's diff in one git
invocation and return it in one HTTP response today
(`HostedWorkspaceViewerService.ts:2436-2529`, delegating to `getCommitDiff`
in `src/utils/GitUtils.ts:313-327`). `DiffFileList`'s `VirtualizedList`-based
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

## Implementation decisions (finalized during planning, 2026-08-26)

The sections above left the contract shape and client wiring open ("a
parallel paged type/endpoint alongside the existing one", "confirm against
profiling"). The codebase already has two working precedents for exactly
this shape — `getFileHistory`/`file-history` (list pagination) and
`getFileHistoryDiff`/`file-history-diff` (per-file structured payload) — so
this section pins the design down against those precedents instead of
leaving it to each implementation session to reinvent:

- **New, separate route and types — do not overload the existing
  `/api/workspace-viewer/git-ref-diff` route or `WorkspaceGitRefDiffResponse`
  type.** Add `GET /api/workspace-viewer/git-ref-diff-page` (query params:
  `ref`, `repo?`, `offset?`, `pageSize?`, `diffId?`), mirroring how
  `file-history` and `file-history-diff` are two distinct routes rather than
  one polymorphic one. The existing route/type/service method are untouched
  and keep serving Download and `getWorktreeDiff` exactly as today.
- **New types in `HostedWorkspaceViewerTypes.ts`**, alongside the
  `WORKSPACE_FILE_HISTORY_*` constants (`:348-350`):
  - `WorkspaceGitRefDiffEntry`: `path`, `oldPath?`, `changeType`,
    `payloadKind`, `language?`, `oldContent?`, `newContent?` (TEXT),
    `image?` (IMAGE) — the same per-file fields `WorkspaceFileHistoryDiffResponse`
    already carries (`:399-406`), minus the commit-metadata fields, since a
    diff page has many files under one shared `commitInfo` instead of one
    file under one commit.
  - `WorkspaceGitRefDiffPageResponse`: `diffId`, `pageSize`, `totalEntries`,
    `offset`, `entries: WorkspaceGitRefDiffEntry[]`, `commitInfo?:
WorkspaceCommitInfo` — shaped exactly like `WorkspaceFileHistoryPageResponse`
    (`:361-370`) with `commitInfo` added. Attach `commitInfo` to _every_ page
    response (not just the first), sourced from the frozen snapshot — cheap,
    and it avoids the client needing to special-case which page carries
    metadata.
  - `WORKSPACE_GIT_REF_DIFF_DEFAULT_PAGE_SIZE` / `_MIN_PAGE_SIZE` /
    `_MAX_PAGE_SIZE` constants, analogous to the file-history ones. Diff
    cards are heavier than history rows, so default lower (e.g. 20) — the
    exact number is an implementer judgment call, not load-bearing.
- **Server snapshot**: a new `gitRefDiffSnapshots` map on
  `HostedWorkspaceViewerService`, following the exact `fileHistorySnapshots`
  pattern (`:141-149`, `:1806-1922`, `:2031-2075`) — id generation, TTL +
  LRU trim via dedicated `GIT_REF_DIFF_SNAPSHOT_TTL_MS` /
  `_MAX_COUNT` constants, `offset % pageSize !== 0` / out-of-bounds
  rejection via `WorkspaceTreeBadRequestError`, expired-id rejection via
  `WorkspaceTreeExpiredError`. On first request (no `diffId`): resolve
  `repoRoot`, reuse `getGitRefDiff`'s existing ref-classification branches
  (`~diff` / `~staged` / `~stash:N` / commit hash, `:2440-2528`) to compute
  the same `{ baseRef, targetRef?, targetIsWorkingTree }` sources plus
  `changedFiles` via `getChangedFilesWithBinaryStatus` (a `--raw --numstat`
  call — already cheap and NOT the `maxBuffer` risk) and, for a commit ref,
  `commitInfo` via `getCommitInfo`. Freeze all of that into the snapshot.
  Reject a `diffId` whose stored ref/repo don't match the request, same as
  `getFileHistory` does for path/repo (`:1831-1838`).
- **Per-page git invocation — this is what actually avoids the `maxBuffer`
  failure, not just the response pagination.** For each changed file in the
  requested page slice, fetch old/new blob bytes with the existing
  `getBlobBytes` helper (already used by `buildNonTextDiffEntries` and
  `getFileHistoryDiff`) and classify text/image/binary the same way
  `getFileHistoryDiff` already does (`:1978-2016`) — never call
  `getCommitDiff`/`git show -p` for the paged path. Extract the shared
  "bytes → text/image/binary `WorkspaceGitRefDiffEntry`" logic that
  `getFileHistoryDiff` and `buildNonTextDiffEntries` each partially
  duplicate today into one private helper reused by both the new paged path
  and (optionally, if it nets less duplication) the existing methods — but
  the existing `unifiedDiff`/`nonTextEntries` response bytes must not change
  as a result of that refactor.
- **Client contract carries ready-to-render entries, not a second deferred
  fetch.** `DiffFileCard`'s `content` source kind already computes hunks
  lazily per-card at render time (see its `case WORKSPACE_ENTRY_KINDS.CONTENT`
  branch) — a `WorkspaceGitRefDiffEntry` page entry maps straight to
  `{ kind: "content", oldContent, newContent }` (or `image`/`binary`), the
  same mapping `WorkspaceDiffPane`'s existing `sourceForParsedFile` already
  does. The `DiffFileHistoryList`/`DeferredDiffDetailFetcher` two-stage
  fetch-on-expand pattern does not apply here and should not be copied —
  that pattern exists because file-history entries are metadata-only until a
  specific commit is expanded, whereas a git-ref-diff page's entries are
  already the full per-file payload once the page arrives.
- **Client hook**: `usePagedGitRefDiff`, a sibling to `usePagedFileHistory`
  scoped by `(ref, repo)` instead of `(path, repo)`, returning a controller
  with the same shape (`getEntry`, `totalCount`, `onRangeChange`, etc.) plus
  `commitInfo` and `refLabel` surfaced from the page response/ref string.
- **`WorkspaceDiffPane` owns the hook directly** (does not delegate it
  inside the list component) so it can read `controller.commitInfo` for the
  existing header banner and collapsible commit-details block, then pass
  `controller` down via the same `controller?: PagedFileHistoryController`
  override prop `DiffFileHistoryList` already supports (`DiffFileHistoryList.tsx:34`)
  — the new list component takes the equivalent prop so the pane's hook
  instance is the only fetch, not a second one owned by the list.
- **Store simplification**: `workspaceViewerStore.ts`'s `openToGitRef`
  (`:707-748`) currently awaits `workspaceGitRefDiff` and stores
  `diffFiles`/`diffNonTextEntries`/`diffCommitInfo`/`diffRefLoading`. Once
  `WorkspaceDiffPane` owns `usePagedGitRefDiff` for the ref/commit-diff path,
  `openToGitRef` only needs to set `diffRef` (and can become synchronous —
  `diffRefLabel` is already derivable from the ref string alone, with no
  fetch). Do **not** remove `diffFiles`/`diffNonTextEntries`/`diffCommitInfo`/
  `diffRefLoading` from the store entirely — `openToWorktreeDiff` (`:750-782`)
  keeps using them unchanged; see scope note below.
- **`getWorktreeDiff`/`openToWorktreeDiff` is out of scope for this plan.**
  The problem statement and non-goals below are about `getGitRefDiff`
  specifically; worktree-diff (one worktree run's branch vs. its base
  commit) is a materially smaller, rarer diff and stays on the existing
  single-shot `workspaceWorktreeDiff` → `DiffFileList` path exactly as today.
  Do not fold it into this pagination work.

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

See "Implementation decisions" above for the finalized contract shape,
route/type names, and snapshot design — this section is now just a file
map, not a set of open options.

### Contracts and server

- `src/types/HostedWorkspaceViewerTypes.ts` — new `WorkspaceGitRefDiffEntry`
  and `WorkspaceGitRefDiffPageResponse` types, plus
  `WORKSPACE_GIT_REF_DIFF_{DEFAULT,MIN,MAX}_PAGE_SIZE` constants, alongside
  the existing `WORKSPACE_FILE_HISTORY_*` ones (`:348-350`).
- `src/server/CtrlYokeHostedServer.ts` — new
  `GET /api/workspace-viewer/git-ref-diff-page` route, following the
  thin-handler pattern already used for `file-history`/`file-history-diff`
  (`:1057-1153`). The existing `git-ref-diff` route (`:1352-1373`) is
  untouched.
- `src/server/HostedWorkspaceViewerService.ts` — new `gitRefDiffSnapshots`
  map plus `getGitRefDiffPage(...)` method, modeled directly on
  `fileHistorySnapshots`/`getFileHistory` (`:141-149`, `:1806-1922`,
  `:2031-2075`). The existing `getGitRefDiff` (`:2436-2529`) and
  `buildNonTextDiffEntries` (`:2368-2434`) are untouched in behavior, though
  a shared per-file byte-classification helper may be extracted from
  `buildNonTextDiffEntries`/`getFileHistoryDiff` (`:1978-2016`) for reuse by
  the new paged path.
- `src/utils/GitUtils.ts` — no changes expected; the paged path uses the
  existing `getBlobBytes` helper (`:334-360`) per file instead of
  `getCommitDiff`'s single `git show -p`, which is what actually avoids the
  `maxBuffer` failure mode (not response pagination alone).

### Client

- `src/ui/webview-react/utils/hostedApi.ts` — new `workspaceGitRefDiffPage`
  fetch helper, patterned after `workspaceFileHistory` (`:290-310`).
- `src/ui/webview-react/hooks/usePagedFileHistory.ts` — reference pattern for
  the new sibling `usePagedGitRefDiff` hook, scoped by `(ref, repo)` instead
  of `(path, repo)`, additionally surfacing `commitInfo`/`refLabel`.
- `src/ui/webview-react/components/diff/DiffFileHistoryList.tsx` — reference
  pattern for a new `DiffFileList`-replacement component (e.g.
  `DiffRefDiffList`) in `WorkspaceDiffPane`'s commit/ref view, built on
  `VirtualizedPagedList`. Unlike `DiffFileHistoryList`, entries render
  directly (`content`/`image`/`binary` source) — no `deferred` fetch stage,
  since a page's entries already carry full payloads. Accept the same
  `controller?` override prop `DiffFileHistoryList` does (`:34`) so
  `WorkspaceDiffPane` can own the hook instance itself.
- `src/ui/webview-react/components/workspace-viewer/WorkspaceDiffPane.tsx` —
  call `usePagedGitRefDiff` directly for the commit/ref (`commitGroups`)
  path, read `commitInfo` from its controller for the header banner /
  commit-details block, and pass the controller into the new list component;
  the single working-tree file diff (`singleFileGroups`) is unaffected since
  it was never the unbounded-payload case.
- `src/ui/webview-react/store/workspaceViewerStore.ts` — simplify
  `openToGitRef` (`:707-748`) to just set `diffRef` (no fetch needed once the
  pane owns the paged hook). Leave `openToWorktreeDiff` (`:750-782`) and the
  `diffFiles`/`diffNonTextEntries`/`diffCommitInfo`/`diffRefLoading` fields
  it still depends on unchanged — worktree-diff is out of scope (see above).
- Retain the existing Download action's use of the single-shot `unifiedDiff`
  string unchanged (`WorkspaceDiffPane.tsx:153-186`, `workspaceGitRefDiff`).

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
