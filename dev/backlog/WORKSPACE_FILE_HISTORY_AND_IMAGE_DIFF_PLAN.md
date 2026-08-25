# Workspace File History and Image Diff Plan

**Status:** Proposed  
**Priority:** P2

## Problem

The workspace viewer can open a working-tree diff for one file and can render
textual diffs for a whole commit/ref, but it cannot answer the common question
“what changed in this file over time?” There is no file-history action in the
explorer context menu, and the current commit log is repository-wide rather
than path-specific.

Image changes have a related gap. The file editor already receives an image as
a `data:` URI, but SCM diff responses expose only UTF-8 `oldContent` and
`newContent`. Git binary stanzas therefore produce no hunks, and
`WorkspaceDiffPane` filters those files out of the commit view.

This plan adds file-level history first, including paged loading suitable for a
virtualized diff list, and adds image diffs to the same `DiffFileCard` surface.
Directory history and virtualization of the existing repository-wide history
pane remain follow-on work.

## Findings from the current codebase

- `WorkspaceDiffPane` currently has two projections: a single working-tree
  file (`selectedDiffPath` plus `diffOldContent`/`diffNewContent`) and a
  multi-file git-ref diff (`diffFiles`). It already owns the commit header,
  expand/collapse-all controls, download action, and scroll container.
- `DiffFileCard` is the shared file-level container. Its text body is always
  `DiffView`, with one of three existing sources: hunks, raw content, or a
  structured patch. `DiffFileList` supplies controlled collapse/gap state and
  virtualizes file rows through `VirtualizedList` once there are at least 30
  files.
- The virtualizer requires a cheap, stable estimate per row. The existing
  `diffFileRows.ts` estimator already accounts for card chrome, notes, text
  source geometry, and responsive split/unified layout; an image/deferred
  source must add a bounded estimate without decoding or measuring image data.
- `useWorkspaceExplorerContextMenu` receives only `onRefresh` and `onOpenFile`
  callbacks. It already knows whether an entry is a file or directory and
  whether the listing is the virtual multi-root top level.
- `workspaceViewerStore.openToDiff()` is the existing cross-pane navigation
  pattern: it selects the destination synchronously, switches to Source
  Control, and leaves a pending request for `WorkspaceSourceControlPane` to
  consume. File history should use the same request-sequencing pattern so
  desktop and mobile navigation cannot race a stale response.
- `WorkspaceCommitHistoryPane` renders the graph rail and commit rows eagerly
  from the same `commitHistory` array. `WorkspaceSourceControlPane` loads 30
  repository commits initially and appends another 30 from a manual button.
  This is not the right list to extend in the file-history phase: graph lane
  continuity makes repository history a distinct virtualization problem.
- `VirtualizedPagedList` and `usePagedWorkspaceDirectory` already implement
  sparse, absolute-indexed pages, overscan range notifications, retry/error
  handling, and scroll-safe loading. File history should follow that pattern
  rather than inventing an append-only scroll listener.
- `HostedWorkspaceViewerService.getDiff()` reads both sides as text, while
  `getGitRefDiff()` returns one raw unified-diff string. `parseUnifiedDiffToFiles`
  intentionally returns binary stanzas with empty hunks, and
  `WorkspaceDiffPane` currently filters them out with `file.hunks.length > 0`.

## Design

### 1. Add a file-only explorer action

Add `View File History` to the file entry context menu. It should not appear
for directories or the virtual multi-root roots list yet; this keeps the
directory-history question out of the first implementation instead of
offering an action that cannot work.

Thread an `onViewFileHistory(path)` callback from `WorkspaceExplorerPane` into
`useWorkspaceExplorerContextMenu`. The callback should call a store action
such as `openToFileHistory(path)`, which synchronously records the normalized
workspace-relative path, switches to Source Control, and publishes a pending
file-history request. Keep repo selection authoritative: the existing
`selectedRepoId`/`prefixRepoIds` logic must scope the request in multi-repo
workspaces.

The Source Control pane should consume that request and render the file-history
projection in its existing diff region. On mobile it should set
`mobileDiffVisible`, matching the current single-file diff behavior. A visible
back action should return to the SCM file list without losing the selected
history path until another projection is chosen.

### 2. Add a paged path-history API

Add shared contracts, a hosted API helper, a server route, and service methods
for two separate operations:

1. `GET /api/workspace-viewer/file-history` returns a page of commit metadata
   for one normalized file path, newest first.
2. `GET /api/workspace-viewer/file-history-diff` returns the before/after
   payload for one history entry when its card is expanded.

The history page should include the full commit identity and display metadata
already used by `WorkspaceCommitLogEntry`, plus the path at each side of a
rename. It should return a stable total count and a history-head/continuation
identity so pages remain consistent if new commits arrive while the user is
scrolling. The request must validate the workspace path and repo exactly as
the existing SCM operations do.

Use Git’s path-aware history (`log --follow` with rename detection) and diff
the selected commit against its first parent. For a root commit, the parent
side is empty. For a rename, use the parent path on the old side and the new
path on the commit side. Do not construct shell arguments by concatenating
untrusted path or ref strings; keep the existing `execFile`/validated-ref
boundary.

Return metadata pages separately from diff payloads. File history should be
cheap to open and scroll, and a collapsed card should not download every
historical file or every image. Cache successful detail responses by
`repo + commit + path` and de-duplicate in-flight requests. Cancel or ignore
responses from an old path/repo/history generation.

Build a `usePagedFileHistory` controller patterned after
`usePagedWorkspaceDirectory`: sparse page map, absolute indexes, generation
guard, retryable page errors, and `onRangeChange` requests covering the
virtualizer’s overscan. Use `VirtualizedPagedList` for the history card list;
the server’s total count lets the user scroll through a long history without
materializing all commit rows. Request the initial page plus only the pages
needed to cover the visible/overscan range. This is the reusable paging lesson
for the later repository-history refactor.

### 3. Model file-history cards without overloading text diff parsing

Keep `DiffFileCard` as the shared outer container, but make its body source a
discriminated union that can represent:

- existing textual hunks/content/patch;
- a deferred history detail (`loading`, `not loaded`, or `error`); and
- an image before/after payload.

The card’s header should show the file path and a compact commit note (subject,
short hash, author/date). History cards should start collapsed. Expanding a
deferred card requests its detail, then renders the appropriate body while
preserving the card’s controlled collapse state. A failed detail request stays
retryable from that card and must not fail the whole list.

Refactor the shared summary/toggle portion of `DiffView` into a small reusable
diff-body control (or an equivalent shared component) so image bodies and text
bodies expose the same familiar “Show/Hide diff” interaction, accessibility
name, and controlled reset semantics. `DiffView` remains responsible for text
parsing, tokenization, hidden-line expansion, and find highlighting; it should
not learn about image decoding.

Add an `ImageDiffView` under `components/diff/`. It should render:

- the old image on the left, labelled `Before`;
- the new image on the right, labelled `After`;
- an explicit empty/deleted/created placeholder when one side is absent;
- `object-contain` sizing inside a bounded, horizontally scrollable frame;
- a transparency checkerboard or equivalent neutral background; and
- useful image alt text and dimensions when available.

Do not use `DiffView` for images. Do not convert images through a canvas just
to compare them; the requested UX is a direct side-by-side before/after view.

### 4. Make normal commit/ref diffs retain image files

Extend the git-ref diff contract so the server can return structured changed
file entries in addition to the existing raw `unifiedDiff` download text. A
structured entry should carry path/change type/rename information and either
text diff data or image-side data. Retain `unifiedDiff` for the existing
download action and compatibility with textual parsing.

For image paths, read Git blobs as bytes and base64-encode them with the
correct MIME type. Use the same centralized image-extension vocabulary used by
workspace file loading. Do not pass binary data through a UTF-8 `stdout`
string. For non-image binary files, keep the file in the list with a clear
“binary diff preview unavailable” body rather than silently dropping it.

Update the client adapter and `WorkspaceDiffPane` so a file is displayable when
it has text hunks *or* an image/binary payload. The existing `visibleFiles`
filter must not discard image entries. Map structured text entries to the
current `DiffView` source and image entries to `ImageDiffView` inside the same
`DiffFileCard`.

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

## Likely implementation surface

### Contracts and server

- `src/types/HostedWorkspaceViewerTypes.ts`
- `src/ui/webview-react/utils/hostedApi.ts`
- `src/server/CtrlYokeHostedServer.ts`
- `src/server/HostedWorkspaceViewerService.ts`
- `src/utils/GitUtils.ts` or a focused SCM history helper

### Workspace viewer and diff UI

- `src/ui/webview-react/hooks/useWorkspaceExplorerContextMenu.tsx`
- `src/ui/webview-react/components/workspace-viewer/WorkspaceExplorerPane.tsx`
- `src/ui/webview-react/store/workspaceViewerStore.ts`
- `src/ui/webview-react/components/workspace-viewer/WorkspaceDiffPane.tsx`
- `src/ui/webview-react/components/diff/DiffFileCard.tsx`
- `src/ui/webview-react/components/diff/DiffFileList.tsx`
- `src/ui/webview-react/components/diff/ImageDiffView.tsx` (new)
- `src/ui/webview-react/components/output/DiffView.tsx` (only for shared
  summary/toggle extraction if needed)
- `src/ui/webview-react/utils/diffFileRows.ts`
- `src/ui/webview-react/utils/rdvAdapter.ts`
- `src/ui/webview-react/hooks/usePagedFileHistory.ts` (new)

`WorkspaceCommitHistoryPane.tsx` is a follow-on consumer of the paging pattern,
not a required first-phase edit.

## Testing plan

- Service tests: file-history ordering and pagination, stable continuation,
  `--follow` rename behavior, root/deleted commits, multi-repo path scoping,
  path/ref validation, image blob encoding on both sides, and non-image binary
  fallback.
- Context-menu tests: `View File History` appears only for files, invokes the
  callback with the normalized entry path, and does not enable directory or
  roots-list history.
- Store/navigation tests: opening history switches to Source Control,
  publishes the correct pending request, scopes the selected repo, and ignores
  stale responses after a new path is selected.
- Diff component tests: text behavior remains unchanged; image cards render
  before/after labels and placeholders, share the card container, expand and
  collapse correctly, and expose accessible image descriptions.
- Paging/virtualization tests: only the initial visible/overscan pages are
  requested, scrolling requests older pages, sparse placeholders keep their
  estimates, page failures are retryable, card detail requests are lazy and
  de-duplicated, and changing path/repo cancels the old generation.
- `WorkspaceDiffPane` tests: file history renders commit notes newest first,
  normal commit views retain image files even with zero text hunks, and the
  existing download/open-file/global-collapse behavior still works.

## Acceptance criteria

- A user can right-click a file, choose `View File History`, and land in the
  existing workspace diff pane with that file’s commits newest first.
- Opening the history does not fetch the entire log or every historical diff;
  scrolling fetches only the pages needed for the visible overscan, and card
  expansion fetches at most one cached detail request per commit/path.
- Renames, added files, deleted files, root commits, detached/repo-scoped
  histories, and stale navigation responses behave predictably.
- A normal commit/ref diff shows tracked image changes as the same
  `DiffFileCard` container with a side-by-side before/after image view.
- Text diffs retain the current split/unified rendering, gap expansion,
  collapse-all behavior, download support, and virtualization performance.
- Directory history and repository-wide `WorkspaceCommitHistoryPane`
  virtualization are clearly left for follow-on work.
