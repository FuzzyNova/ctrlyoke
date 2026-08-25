# Workspace File History and Image Diff Plan

**Status:** Ready for implementation (derisked)
**Priority:** P2

## Problem

The workspace viewer can open a working-tree diff for one file and can render
textual diffs for a whole commit/ref, but it cannot answer the common question
“what changed in this file over time?” There is no file-history action in the
explorer context menu, and the current commit log is repository-wide rather
than path-specific.

Image changes have a related gap, and it shows up in all three places the
workspace viewer renders a diff, not just the commit view. The file editor
already receives an image as a `data:` URI, but every SCM diff response
exposes only UTF-8 `oldContent`/`newContent`: `getGitRefDiff`'s raw
`unifiedDiff` text produces no hunks for a git binary stanza, so
`WorkspaceDiffPane` filters those files out of the commit view; and
`getDiff()` — the single working-tree file diff opened by clicking one file —
has no binary/image check at all and unconditionally reads the file as
`"utf8"`, so opening a diff on an image today silently decodes its bytes as
garbled text and renders that as a text diff rather than failing cleanly.
File history's own per-commit detail fetch (added by this plan) needs the
same treatment from the start so it isn't shipped with the same gap.

This plan adds file-level history first, including paged loading suitable for a
virtualized diff list, and adds image (and clean binary-fallback) diffs to all
three diff surfaces — commit/ref, single working-tree file, and file-history
detail — on the same `DiffFileCard` surface. Directory history, virtualization
of the existing repository-wide history pane, and paginating large commit
diffs remain follow-on work.

## Key decisions locked in during derisking

These resolve the open questions in the original draft. Each is expanded with
citations in the relevant Design section below.

1. **Server-side path scoping uses `requireRepoRootForPath`, not
   `resolveRepoRoot`.** File history is a path-carrying operation (like
   `getDiff`/`stageFile`), the opposite pattern from ref-scoped operations like
   `getGitRefDiff`/`getCommitLog`. See Design §2.
2. **All new git plumbing (path-scoped log, blob-as-bytes reads) goes in
   `GitUtils.ts`, never as new methods on `HostedWorkspaceViewerService`'s
   local `execFileAsync`.** The service's local wrapper has no `maxBuffer`
   override and inherits Node's 1MB default; `GitUtils.ts`'s wrapper is
   already configured for 50MB. Using the wrong one will throw
   `ERR_CHILD_PROCESS_STDOUT_MAXBUFFER` on a real repo. See Design §2.
3. **There is no existing path-scoped `git log` helper to extend.**
   `getRecentCommits()` is repo-wide with no pathspec or `--follow`. Rename
   pair detection needs fresh `--name-status`/`-z` parsing, not the
   NUL-delimited single-line `--format` `getRecentCommits` uses. See Design §2.
4. **History pagination copies `WorkspaceListingSnapshotCache`'s shape**: a
   server-generated `historyId` bound to a snapshot frozen at the commit that
   was `HEAD` when history was opened, paged by `offset`/`pageSize`. History
   does not "stay live" while the user scrolls — new commits landing during a
   scroll session are not reflected until the pane is reopened. See Design §2.
5. **The file-history card list is not `DiffFileList`.** `DiffFileList` uses
   the dense `VirtualizedList` (all rows known up front); file history needs
   the sparse, server-paged `VirtualizedPagedList` that
   `usePagedWorkspaceDirectory` already uses for the directory tree. These are
   two different components in the codebase today. Each realized row in the
   new list renders one (non-virtualized) `DiffFileCard`. See Design §3.
6. **`workspaceViewerStore.openToDiff()` is a thinner pattern than "the"
   pending-request mechanism** — it's one synchronous `set()` with no
   generation/staleness guard of its own, and `mobileDiffVisible` is a
   separate action the pane sets, not something `openToDiff` sets for you.
   `openToFileHistory` needs its own freshly-built generation guard (pattern
   after `usePagedWorkspaceDirectory`'s internal `generationRef`), not a
   borrowed one. See Design §1.
7. **Image bytes cannot flow through `parseUnifiedDiffToFiles`, and image/
   binary support covers all three diff endpoints, not just `getGitRefDiff`.**
   `parseUnifiedDiffToFiles` is a client-side wrapper around
   `react-diff-view`'s `parseDiff()` over the raw `unifiedDiff` string, so
   image data must arrive as a separate structured field on the git-ref-diff
   response. `getDiff()` (the single working-tree file diff) has the same gap
   but is worse today — it has no binary check and silently decodes image
   bytes as `"utf8"`, rendering garbled text instead of failing cleanly — so
   it needs the same structured-field treatment, not just `getGitRefDiff`.
   File-history's own detail endpoint (§2) must ship with this from day one
   rather than needing a follow-up. All three decode server-side using the
   same `isImageRefPath()`/`imageExtensionToMimeType()` helpers the file
   editor's `data:` URI path already uses. See Design §4.
8. **Paginating large commit/ref diffs is an explicit, named follow-on, not
   part of this phase.** `getGitRefDiff`/`getCommitDiff` already fetch an
   entire commit's diff in one git invocation and one HTTP response today,
   before `DiffFileList`'s `VirtualizedList` makes any rendering decision —
   that virtualization is a DOM optimization only, not a network one. Adding
   base64 image bytes to that same single-shot response (Design §4) makes an
   already-unbounded payload larger for large commits (e.g. a repo-wide
   `npm run format`). Fixing that properly means giving `getGitRefDiff` a
   paginated, structured-entry contract — a bigger change than this plan's
   scope — so it is named explicitly rather than silently expanded into. See
   Design §6.

## Findings from the current codebase

- `WorkspaceDiffPane` has two projections: a single working-tree file
  (`selectedDiffPath` plus `diffOldContent`/`diffNewContent`) and a multi-file
  git-ref diff (`diffFiles`). It owns the commit header, expand/collapse-all
  controls, download action, and scroll container. Its `visibleFiles` filter
  (`file.hunks.length > 0`) is what currently drops binary/image files from a
  commit view — `WorkspaceDiffPane.tsx:39-42`.
- `DiffFileCard`'s body is always `DiffView`, driven by a source union of
  exactly three kinds today: `{kind:"hunks"}`, `{kind:"content"}`,
  `{kind:"patch"}` (`DiffFileCard.tsx:25-32`). Each branch is handed a shared
  `sharedDiffViewProps` bundle (`:83-94`) that includes text-diff-only
  concepts — `expandedGaps`, `onExpandGap`, `findQuery`, `viewType`. New
  `image`/`deferred` source kinds should **not** receive that bundle wholesale;
  only the collapse toggle state (`collapsed`/`onCollapsedChange`) generalizes
  cleanly to a non-text body.
- `DiffFileList` supplies controlled collapse/gap overrides keyed by file
  `row.key` and virtualizes through `VirtualizedList` once there are at least
  `DIFF_FILE_LIST_VIRTUALIZATION_THRESHOLD = 30` files
  (`DiffFileList.tsx:41`), gated on a scroll container being present
  (`:318-320`). This is the dense, fully-realized-array virtualizer — see the
  distinction from `VirtualizedPagedList` below.
- `diffFileRows.ts`'s `estimateDiffFileCardSize` combines a card-chrome
  estimate with a per-`source.kind` body estimate cached in a `WeakMap`
  (`:307-346`). It's a 3-way switch parallel to `DiffFileCard`'s own switch —
  adding `image`/`deferred` branches is a matching, mechanically cheap
  addition as long as each estimate stays O(1) (no image decoding, no
  byte-size-proportional work).
- `useWorkspaceExplorerContextMenu` currently exposes only `onRefresh` and
  `onOpenFile` (`:31-33`), and knows `entry.kind` (file vs. directory) and
  `isRootsList`. **`onOpenFile` is not currently wired to any menu item** — it
  is only invoked internally by `handlePaste` (`:106`) — so there is no
  existing "Open"-style item to copy. The closest pattern for a new,
  always-enabled, file-only item is `handleAddToCtrlYoke`
  (`:64-76,167-174`); the file-vs-directory filter needs to happen at the
  call site, since `openContextMenu` itself only branches on `isRootsList`,
  not `entry.kind`. Wiring point for a new callback:
  `WorkspaceExplorerPane.tsx:399-403`, alongside the existing
  `onOpenFile: openFile`.
- `workspaceViewerStore.openToDiff(path)` is one synchronous `set()` — it
  flips to the Source Control tab, records `selectedDiffPath`, and sets
  `pendingDiff` as a marker for `WorkspaceSourceControlPane` to consume; it
  does not fetch anything itself and does not touch `mobileDiffVisible`
  (a separate action, `setMobileDiffVisible`). Unlike
  `usePagedWorkspaceDirectory`, the store has **no generation counter** for
  this flow today — an `openToFileHistory` clone must add its own staleness
  guard rather than inherit one.
- `WorkspaceCommitHistoryPane`/`WorkspaceSourceControlPane` render the graph
  rail and commit rows eagerly from the full `commitHistory` array, with no
  virtualization. Initial load and each "Load more…" click both fetch exactly
  30 commits (`workspaceCommitLog(0, 30, ...)` and
  `workspaceCommitLog(commitHistory.length, 30, ...)`,
  `WorkspaceSourceControlPane.tsx:143-189`). This is not the list to extend in
  the file-history phase — see Design §5.
- `VirtualizedList` and `VirtualizedPagedList` are **two distinct
  components**. `VirtualizedList` (dense, `items: T[]`) is what `DiffFileList`
  uses today. `VirtualizedPagedList` (sparse, `totalCount`/`getItem(index)`/
  placeholder rendering/`onRangeChange`) is what `usePagedWorkspaceDirectory`
  uses for the directory tree, and is the one file history needs.
  `usePagedWorkspaceDirectory`'s public shape — `totalCount`, `listingId`
  (generation guard), `getEntry(index)`, `loadedOffsets`/`inFlightOffsets`/
  `failedRanges`, `initialLoading`/`pageLoading`/`error`,
  `navigate`/`refresh`/`retry`/`retryPage`, `onRangeChange` — is the concrete
  interface `usePagedFileHistory` should mirror, including its internal
  `generationRef` bump on every new listing and `isCurrent(...)` check before
  applying a response.
- `HostedWorkspaceViewerService.getDiff()` (`:1480-1517`) reads the old side
  via `git show HEAD:<path>` and the new side via `fs.readFile(..., "utf8")`
  **with no binary/image check at all** — unlike the commit-view path, which
  at least cleanly drops binary files via the `hunks.length > 0` filter, an
  image opened through the single-file diff flow today gets its raw bytes
  decoded as UTF-8 and rendered as a garbled text diff. This is a live bug,
  not just a missing feature, and this plan's image work should fix it rather
  than defer it (see Design §4). `getGitRefDiff(ref, repoId?)` (`:1836-1865`)
  is **repo-scoped, not path-scoped** — it dispatches on sentinel refs or a
  commit hash and returns
  `{ unifiedDiff: string; commitInfo?: WorkspaceCommitInfo }`
  (`HostedWorkspaceViewerTypes.ts:325-329`), a raw string. There is no
  existing path-scoped history helper to extend (see decision 3 above).
  `parseUnifiedDiffToFiles` (client-side, `rdvAdapter.ts:103-138`) intentionally
  returns binary stanzas with empty `hunks`, and `WorkspaceDiffPane` currently
  filters those out with `file.hunks.length > 0`.

## Design

### 1. Add a file-only explorer action

Add `View File History` to the file entry context menu. It should not appear
for directories or the virtual multi-root roots list yet; this keeps the
directory-history question out of the first implementation instead of
offering an action that cannot work. Model it on `handleAddToCtrlYoke`
(`useWorkspaceExplorerContextMenu.tsx:64-76,167-174`) — a plain, always-enabled
item — rather than on `onOpenFile`, which has no existing menu-item callsite
to pattern-match. Filter it to `entry.kind === "file"` at the call site in
`WorkspaceExplorerPane.tsx`, since the hook's `openContextMenu` only branches
on `isRootsList`, not entry kind.

Thread an `onViewFileHistory(path)` callback from `WorkspaceExplorerPane` into
`useWorkspaceExplorerContextMenu` next to the existing `onOpenFile: openFile`
wiring (`WorkspaceExplorerPane.tsx:399-403`). The callback should call a new
store action, `openToFileHistory(path)`, patterned after `openToDiff` (one
synchronous `set()`: normalize the path, switch to Source Control, record the
target path, and set a pending-file-history marker) — but, unlike `openToDiff`,
it must add its own generation/staleness token (e.g. an incrementing
`fileHistoryGeneration` field bumped on every call), because the store has no
existing guard for this that can be borrowed. Keep repo selection authoritative
by reading `get().selectedRepoId` the same way `openToGitRef`/
`openToWorktreeDiff` already do, rather than re-deriving it.

The Source Control pane should consume that request and render the
file-history projection in its existing diff region. On mobile it must
explicitly call `setMobileDiffVisible(true)` itself — `openToFileHistory`
will not do this for it, matching how the existing single-file diff flow
already separates these two concerns. A visible back action should return to
the SCM file list without losing the selected history path until another
projection is chosen.

### 2. Add a paged path-history API

Add shared contracts, a hosted API helper, a server route, and service methods
for two separate operations:

1. `GET /api/workspace-viewer/file-history` returns a page of commit metadata
   for one normalized file path, newest first.
2. `GET /api/workspace-viewer/file-history-diff` returns the before/after
   payload for one history entry when its card is expanded.

Follow the existing thin-handler/service-validates split used by
`/api/workspace-viewer/diff` and `/api/workspace-viewer/git-ref-diff`
(`CtrlYokeHostedServer.ts:1017-1039,1229-1250`): the route reads and
400s on missing required query params (`path`, and for the diff route,
`commit`), accepts an optional `repo` query param, and delegates all
existence/scope validation to the service. Because file history is
path-carrying (like `getDiff`, not like `getGitRefDiff`), scope it server-side
with `requireRepoRootForPath(absolutePath)`, **not** `resolveRepoRoot(repoId)`
— this is the opposite of the pattern `getGitRefDiff`/`getCommitLog` use, and
is worth getting right since it's easy to copy the wrong precedent.

The history page should include the full commit identity and display metadata
already used by `WorkspaceCommitLogEntry`
(`HostedWorkspaceViewerTypes.ts:275-289`: `hash`, `shortHash`, `subject`,
`author`, `relativeDate`, `isHead`, `pushed`, `refs`, `isMerge`,
`parentHashes`), plus the path at each side of a rename. Paginate it the same
way `WorkspaceListingSnapshotCache` paginates directory listings
(`src/server/WorkspaceListingSnapshotCache.ts`): generate a `historyId`
(`randomUUID()`) bound to a snapshot **frozen at the commit that was `HEAD`
when history was opened**, page by `offset`/`pageSize` validated against that
snapshot, and reject misaligned/out-of-bounds requests the same way
`HostedWorkspaceViewerService.ts:1004-1024` does for directory paging. Do not
attempt to keep the history "live" against new commits arriving mid-scroll —
freeze-at-open is the explicit, simpler contract.

There is no existing path-scoped `git log` helper — `getRecentCommits()`
(`GitUtils.ts:112-171`) is repo-wide with no pathspec or `--follow`. This is
genuinely new code, added to `GitUtils.ts` (not as a new method on
`HostedWorkspaceViewerService`'s local `execFileAsync`, which has no
`maxBuffer` override and inherits Node's 1MB default — `GitUtils.ts`'s
wrapper is already configured with a 50MB `maxBuffer` and an argv-array
`execFileAsync`, and a `git log --follow` on a long-lived file or a large
image blob will exceed 1MB). Use `git log --follow` with rename detection,
but note that recovering the "path at each side of a rename" per-commit needs
`--name-status`/`-z` output parsed per commit, not the NUL-delimited
single-line `--format` string `getRecentCommits` uses today — this is fresh
parsing, not a copy. Be aware `--follow` only accepts a single pathspec and
its rename tracking can behave differently across merge commits and git
versions; the default 50% similarity threshold is not currently configurable
by this plan and should stay that way unless a real need appears.

Diff the selected commit against its first parent using the same
`git show <hash>` single-arg form `getCommitDiff` already uses
(`GitUtils.ts:218-232`) — for a root commit this already diffs against git's
empty tree implicitly, so no special-cased empty-tree ref construction is
needed. For a rename, use the parent path on the old side and the new path on
the commit side. Do not construct shell arguments by concatenating untrusted
path or ref strings; keep the existing `execFile`/validated-ref boundary.

Return metadata pages separately from diff payloads. File history should be
cheap to open and scroll, and a collapsed card should not download every
historical file or every image. Cache successful detail responses by
`repo + commit + path` and de-duplicate in-flight requests. Cancel or ignore
responses from an old path/repo/history generation.

`file-history-diff` must return the same structured text-or-image-or-binary
shape as `getGitRefDiff`'s new structured entries (Design §4) from the start
— reuse the same blob-as-bytes/MIME helpers and the same "binary diff preview
unavailable" fallback body, rather than shipping file history with text-only
support and adding images to it later. A history entry for an image file is
exactly as common as a commit touching an image file, so this isn't optional
scope.

Build a `usePagedFileHistory` controller patterned after
`usePagedWorkspaceDirectory`: sparse page map, absolute indexes, generation
guard (keyed on repo + path, since a history listing is scoped to both),
retryable page errors, and `onRangeChange` requests covering the
virtualizer's overscan. Use `VirtualizedPagedList` (not `DiffFileList`'s
`VirtualizedList`) for the history card list — each realized row renders one
(non-virtualized) `DiffFileCard`; the server's total count lets the user
scroll through a long history without materializing all commit rows. Request
the initial page plus only the pages needed to cover the visible/overscan
range. This is the reusable paging lesson for the later repository-history
refactor.

### 3. Model file-history cards without overloading text diff parsing

Keep `DiffFileCard` as the shared outer container, but make its body source a
discriminated union that can represent:

- existing textual hunks/content/patch;
- a deferred history detail (`loading`, `not loaded`, or `error`); and
- an image before/after payload.

Give the deferred source its own state machine in its variant data (`not
loaded` / `loading` / `loaded` / `error`) rather than trying to encode
fetch-in-progress in `DiffFileList`'s existing collapse-override `Map` — that
map only tracks collapsed/expanded UI state today and has no concept of
"has this card's detail been requested yet."

The card's header should show the file path and a compact commit note
(subject, short hash, author/date). History cards should start collapsed.
Expanding a deferred card requests its detail, then renders the appropriate
body while preserving the card's controlled collapse state. A failed detail
request stays retryable from that card and must not fail the whole list.

Extracting a reusable diff-body toggle out of `DiffView` (`:485-524`, the
chevron/label/stats/`actionSlot` block) is moderate-risk, not mechanical: the
toggle today is driven by `isExpanded`/`handleToggle`'s dual controlled/
uncontrolled state plus `summaryStats` and `estimatedLineCount`, both derived
from hunks. A generic version usable by `ImageDiffView` needs those two
values passed in as pre-computed optional props rather than computed inside
the shared control — or, if that proves awkward, it is acceptable to keep two
toggle renderers sharing only markup/CSS rather than force a single component.
`DiffView` already returns `null` for a diff with no hunks (`:478`), which
confirms images must go through a fully separate component, never a `DiffView`
mode.

Add an `ImageDiffView` under `components/diff/`. It should render:

- the old image on the left, labelled `Before`;
- the new image on the right, labelled `After`;
- an explicit empty/deleted/created placeholder when one side is absent;
- `object-contain` sizing inside a bounded, horizontally scrollable frame;
- a transparency checkerboard or equivalent neutral background; and
- useful image alt text and dimensions when available.

Do not use `DiffView` for images. Do not convert images through a canvas just
to compare them; the requested UX is a direct side-by-side before/after view.

Two accessibility/interaction details to settle up front rather than
discover late:

- `DiffFileCard`'s `aria-setsize`/`aria-posinset` (`:126-137`) are computed
  from a fully-realized array in `DiffFileList`. A `VirtualizedPagedList`
  history list has an authoritative `totalCount` but sparse local rows —
  `aria-setsize` can use `totalCount` directly, but a not-yet-loaded
  placeholder row has no file to attach `aria-posinset` to. Give placeholder
  rows no `article`/`aria-posinset` until loaded, matching
  `VirtualizedPagedList`'s existing `renderPlaceholder` slot pattern for the
  directory tree.
- Global find (`findQuery`/`findCaseSensitive`) against a card whose detail
  arrives asynchronously after the card is already mounted should just work,
  since `DiffView`'s find state is local and re-scans on render — but include
  one explicit test for it rather than leaving it implicit (see Testing plan).

### 4. Make every diff surface retain image files and show a clean binary fallback

This applies to all three places a diff is fetched — `getGitRefDiff` (commit/
ref), `getDiff` (single working-tree file), and the new `file-history-diff`
(§2) — using one shared server-side image/binary read path, not three
separate implementations.

**Shared read path.** For image paths, read Git blobs as bytes via a new
`GitUtils.ts` helper (`git show <hash>:<path>` with `{ encoding: "buffer" }`
passed through `execFile`) and base64-encode them with the correct MIME type
— this is genuinely new plumbing, since both existing `execFileAsync`
wrappers in the codebase are currently only used for UTF-8 `stdout`. Reuse
the same helpers the file editor's `data:` URI path already uses in
`HostedWorkspaceViewerService.readFile()` (`:1107-1121`): `isImageRefPath()`
and `imageExtensionToMimeType()` from `src/types/DashboardConstants.ts`
(`:1450-1456`, `:1485-1501`). Do not pass binary data through a UTF-8 `stdout`
string. For non-image binary files, keep the file in the list/response with a
clear "binary diff preview unavailable" body rather than silently dropping
it or (for the working-tree path) decoding it as garbled text.

**`getGitRefDiff` (commit/ref).** Extend the contract so the server can
return structured changed-file entries in addition to the existing raw
`unifiedDiff` download text. This must be a **separate structured field**,
not something threaded through the raw diff text: `parseUnifiedDiffToFiles`
runs client-side over the `unifiedDiff` string (`rdvAdapter.ts:103-138`) and
cannot carry binary payloads, so image data has to be attached server-side as
its own array on `WorkspaceGitRefDiffResponse`. A structured entry should
carry path/change-type/rename information and either text diff data or
image-side data. Retain `unifiedDiff` for the existing download action and
compatibility with textual parsing.

**`getDiff` (single working-tree file).** This path has no binary check
today (`HostedWorkspaceViewerService.ts:1480-1517`) and silently mis-renders
images as garbled text — fix this, not just extend it. Before reading the new
side as UTF-8, check `isImageRefPath()` on the resolved path; if it's an
image, skip the text read entirely and return image-side data (old blob via
the same blob-as-bytes helper, new side via the same base64 path
`readFile()`'s `data:` URI logic already uses) instead of `oldContent`/
`newContent` strings. Widen `WorkspaceScmDiffResponse`
(`HostedWorkspaceViewerTypes.ts:199-205`) with the same discriminated
text-or-image-or-binary shape used for the other two endpoints, rather than
inventing a fourth shape.

**Client side.** Update the client adapter and `WorkspaceDiffPane` so a file
is displayable when it has text hunks *or* an image/binary payload, on both
its `commitGroups` mapping and its `singleFileGroups` mapping
(`WorkspaceDiffPane.tsx:39-63,64-88`) — both need the same source-kind switch
extended, not just the commit one. Widen `ParsedDiffFile`
(`rdvAdapter.ts:33-40`) with an optional image/binary variant, and update the
`visibleFiles` filter to pass image/binary entries through instead of
filtering them out. Map structured text entries to the current `DiffView`
source and image entries to `ImageDiffView` inside the same `DiffFileCard`;
give non-image binary entries a small inline "binary diff preview
unavailable" body (no `ImageDiffView`, no `DiffView`).

Update `diffFileRows.ts` with cached, bounded image/deferred estimates. The
estimate must depend only on the source identity and primitive layout inputs;
it must never inspect image dimensions by decoding an offscreen image or do
work proportional to the file’s byte size.

### 5. Keep repository-wide history as a follow-on

Do not virtualize `WorkspaceCommitHistoryPane` in the file-history change. Its
graph rail and text rows must remain vertically synchronized, and lane colors
can continue across pages/branches. A later phase should:

- extract the range/paging controller shape learned from file history;
- virtualize one shared row range for both the SVG graph rail and commit text;
- preserve graph lane continuity at the loaded-window boundaries; and
- replace the manual `Load more…` button with overscan-driven loading while
  retaining refresh, detached-HEAD branch hints, checkout actions, and context
  menus.

Directory history is also explicitly out of scope for this plan.

### 6. Paginate large commit/ref diffs (follow-on, not this phase)

`DiffFileList` should not be retrofitted into a paged component, and this
phase should not try to solve large-commit scalability as a side effect of
adding image support. `DiffFileList` has exactly two production consumers
today: `WorkspaceDiffPane` (network-backed, no selection UI) and
`UndoChangesDialog` (`components/output/UndoChangesDialog.tsx`) — and the
latter's checkbox multi-select, "N of M selected" / select-all, and bulk
undo/redo submit all require the complete checkable row set to be known
synchronously. That need is what keeps `DiffFileList` dense; it is not an
accident of running in the panel versus the hosted dashboard, so a
"paged with a dense panel fallback" retrofit of `DiffFileList` itself would
be solving the wrong axis.

Separately, note that a large `maxBuffer` overflow in `GitUtils.ts` (default
`GIT_MAX_BUFFER = 50MB`, `:8`) is not silent data loss — `execFile` throws
`ERR_CHILD_PROCESS_STDOUT_MAXBUFFER` on overflow, which hard-fails the whole
commit view rather than truncating it. There is already a precedent for
raising this per call site (`getGitTrackedFiles` overrides to 500MB for large
monorepos, `GitUtils.ts:502`), but raising the cap only delays the failure —
it does nothing for response latency, peak memory, or the additional inflation
from base64-encoded image bytes once Design §4 ships.

The follow-on: generalize the paged list component this plan builds for file
history (§2/§3 — `VirtualizedPagedList` with one `DiffFileCard` per realized
row) so `WorkspaceDiffPane`'s commit/ref diff view uses it too, and give
`getGitRefDiff` a paginated, structured-entry server contract — a
frozen-at-open snapshot paged by `offset`/`pageSize`, the same shape as the
file-history design in §2 — instead of returning one unbounded diff blob.
Keep the existing single-shot `unifiedDiff` string response only for the
explicit Download action, which legitimately needs the whole file and is not
latency-sensitive in the same way an initial render is.

## Likely implementation surface

### Contracts and server

- `src/types/HostedWorkspaceViewerTypes.ts` — new file-history contracts;
  extend `WorkspaceGitRefDiffResponse` with a structured-entries field; widen
  `WorkspaceScmDiffResponse` (`:199-205`) with the same text-or-image-or-binary
  shape for the single-file working-tree diff.
- `src/ui/webview-react/utils/hostedApi.ts`
- `src/server/CtrlYokeHostedServer.ts` — new
  `/api/workspace-viewer/file-history` and `/file-history-diff` routes,
  following the thin-handler pattern of the existing `diff`/`git-ref-diff`
  routes.
- `src/server/HostedWorkspaceViewerService.ts` — new service methods using
  `requireRepoRootForPath`; snapshot/pagination modeled on
  `WorkspaceListingSnapshotCache` (`src/server/WorkspaceListingSnapshotCache.ts`,
  reference pattern, not directly reused since it's shaped for directory
  entries); fix `getDiff()` (`:1480-1517`) to detect images via
  `isImageRefPath()` before reading the new side as `"utf8"`, instead of
  silently mis-decoding image bytes as text.
- `src/utils/GitUtils.ts` — new path-scoped log/rename-pair helper and new
  blob-as-bytes helper; both must use this file's existing 50MB-`maxBuffer`
  `execFileAsync`, not `HostedWorkspaceViewerService`'s local one.

### Workspace viewer and diff UI

- `src/ui/webview-react/hooks/useWorkspaceExplorerContextMenu.tsx` — new
  `onViewFileHistory` callback, modeled on `handleAddToCtrlYoke`.
- `src/ui/webview-react/components/workspace-viewer/WorkspaceExplorerPane.tsx`
  — wire the new callback next to `onOpenFile: openFile` (`:399-403`).
- `src/ui/webview-react/store/workspaceViewerStore.ts` — new
  `openToFileHistory(path)` action with its own generation guard field.
- `src/ui/webview-react/components/workspace-viewer/WorkspaceDiffPane.tsx` —
  render the file-history projection; stop filtering out image/binary
  entries in `visibleFiles` (`commitGroups`); extend `singleFileGroups`
  (`:64-88`) with the same image/binary source kinds for the working-tree
  diff.
- `src/ui/webview-react/components/diff/DiffFileCard.tsx` — widen the source
  union with `image`/`deferred` kinds.
- `src/ui/webview-react/components/diff/ImageDiffView.tsx` (new)
- `src/ui/webview-react/components/diff/` — new paged file-history list
  component built on `VirtualizedPagedList`. This is **not** `DiffFileList`,
  which is built on the dense `VirtualizedList` and is not touched by this
  plan except where noted for image row estimates.
- `src/ui/webview-react/components/output/DiffView.tsx` — only for the
  optional shared toggle extraction (moderate risk; see Design §3 — two
  parallel toggle renderers are an acceptable fallback if a clean generic
  extraction doesn't materialize quickly).
- `src/ui/webview-react/utils/diffFileRows.ts`
- `src/ui/webview-react/utils/rdvAdapter.ts` — widen `ParsedDiffFile` with an
  image/binary variant.
- `src/ui/webview-react/hooks/usePagedFileHistory.ts` (new), patterned on
  `src/ui/webview-react/hooks/usePagedWorkspaceDirectory.ts`.

`WorkspaceCommitHistoryPane.tsx` is a follow-on consumer of the paging pattern,
not a required first-phase edit.

## Testing plan

- Service tests: file-history ordering and pagination against a snapshot
  frozen at open time, stable continuation via `historyId`, `--follow` rename
  behavior including the parsed rename path pair, root/deleted commits (via
  `git show`'s implicit empty-tree diff), multi-repo path scoping through
  `requireRepoRootForPath`, path/ref validation, image blob encoding on both
  sides, non-image binary fallback, and a large-file/large-history case that
  would overflow Node's default 1MB `maxBuffer` if routed through the wrong
  `execFileAsync` wrapper. Explicitly cover `getDiff()` on an image path
  (regression test for today's garbled-text bug — assert image data is
  returned, not UTF-8-decoded bytes) and `file-history-diff` on an image path
  (parity with `getGitRefDiff`'s structured image entries, not text-only).
- Context-menu tests: `View File History` appears only for files, invokes the
  callback with the normalized entry path, and does not enable directory or
  roots-list history.
- Store/navigation tests: opening history switches to Source Control,
  publishes the correct pending request, scopes the selected repo, bumps the
  new generation token, and ignores stale responses after a new path is
  selected; mobile visibility is set by the consumer, not by the store action
  itself.
- Diff component tests: text behavior remains unchanged; image cards render
  before/after labels and placeholders, share the card container, expand and
  collapse correctly, and expose accessible image descriptions; placeholder
  rows in the paged history list render without `aria-posinset` until loaded.
- Paging/virtualization tests: only the initial visible/overscan pages are
  requested, scrolling requests older pages, sparse placeholders keep their
  estimates, page failures are retryable, card detail requests are lazy and
  de-duplicated, changing path/repo cancels the old generation, and the
  history list renders through `VirtualizedPagedList` (not `DiffFileList`).
- `WorkspaceDiffPane` tests: file history renders commit notes newest first,
  normal commit views retain image files even with zero text hunks, the
  existing download/open-file/global-collapse behavior still works, and a
  global find query against a card whose detail loads asynchronously still
  highlights correctly once loaded.

## Acceptance criteria

- A user can right-click a file, choose `View File History`, and land in the
  existing workspace diff pane with that file’s commits newest first.
- Opening the history does not fetch the entire log or every historical diff;
  scrolling fetches only the pages needed for the visible overscan, and card
  expansion fetches at most one cached detail request per commit/path.
- History is explicitly a snapshot frozen at the commit that was `HEAD` when
  it was opened — new commits landing mid-scroll are not expected to appear
  until the pane is reopened.
- Renames, added files, deleted files, root commits, detached/repo-scoped
  histories, and stale navigation responses behave predictably.
- A normal commit/ref diff, a single-file working-tree diff, and a
  file-history detail view all show tracked image changes as the same
  `DiffFileCard` container with a side-by-side before/after image view, and
  all three show the same clear "binary diff preview unavailable" fallback
  for non-image binaries instead of an empty/garbled result. Opening a
  single-file diff on an image no longer renders decoded binary bytes as
  text.
- Text diffs retain the current split/unified rendering, gap expansion,
  collapse-all behavior, download support, and virtualization performance.
- Directory history, repository-wide `WorkspaceCommitHistoryPane`
  virtualization, and paginating `getGitRefDiff` itself for very large commits
  are clearly left for follow-on work; `DiffFileList` is not modified by this
  plan.
</content>
