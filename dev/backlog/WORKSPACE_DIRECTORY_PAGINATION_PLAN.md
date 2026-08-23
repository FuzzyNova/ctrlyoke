# Workspace Directory Pagination and Virtualization Plan

## Goal

Remove the workspace browser's silent 1,000-entry cutoff while keeping large
directories responsive on desktop and mobile.

Both web workspace browsers must make every immediate child of the current
directory reachable:

- `WorkspaceExplorerPane` in the hosted workspace viewer.
- `FileBrowserModal`, used by hosted-browser file and directory pickers.

Use server-backed range paging to bound each HTTP response and shared list
virtualization to bound mounted React rows. Loading file contents remains a
separate, on-demand request made only when a user opens a file.

## Why the Current Limit Exists

`HostedWorkspaceViewerService.ts` currently declares
`MAX_ENTRIES = 1000`. `listDirectory()` reads the complete directory, sorts
directories and files by name, then runs:

```ts
const allEntries = [...dirs, ...files].slice(0, MAX_ENTRIES);
```

Git history traces this line to the first workspace-viewer implementation
(`c4b22dc6`, 2026-04-28). The corresponding implemented plan did not record a
measured network, filesystem, or React threshold; it said only to “add a
directory entry count cap if needed to protect mobile rendering.” Treat 1,000
as a provisional first-pass guard, not an intentional product boundary.

The cap protects three things today:

- at most 1,000 file `stat` calls are issued for size metadata;
- the JSON response contains at most 1,000 entry objects; and
- the React clients mount at most 1,000 row buttons.

It does **not** bound filesystem name enumeration or the server's initial sort.
`fs.promises.readdir()` has already read every immediate entry before the slice
is applied. Raising or removing only the slice would therefore fix correctness
but would transfer the remaining cost directly to the network and DOM.

There is currently no `totalEntries`, pagination cursor, truncation flag, “Load
more,” or “Load all” behavior in the tree response. The cutoff is silent.

## Existing Content-Loading Boundary

The current architecture already avoids the expensive mistake of loading every
file's contents with the directory tree:

- `GET /api/workspace-viewer/tree` returns names, workspace-relative paths,
  kind, optional size, and git-ignore metadata only.
- `WorkspaceExplorerPane.openFile()` calls `workspaceFile(path)` only after a
  file is selected.
- `FileBrowserModal` never requests file contents; it only returns the selected
  path to its caller.
- `HostedWorkspaceViewerService.readFile()` independently enforces binary and
  2 MB text-file safeguards.

Keep this separation. Pagination applies only to lightweight directory-entry
metadata and must not merge tree and file-content routes.

## Product Decisions

### Use virtual range paging, not a larger fixed cap

A conventional append-only “Load more” list works for feeds, but a file
explorer has stronger requirements:

- the scrollbar should represent the full directory rather than grow whenever
  the user reaches the bottom;
- dragging directly to the end of a large directory should load that range,
  not force every preceding page to download first;
- Sync Explorer must reveal an already-open file even when its row is far from
  the first page; and
- Name/Date modified sorting must be correct across the whole directory, not
  only across entries loaded so far.

Use an immutable, server-side listing snapshot plus offset/range requests. The
first response reports the full entry count and one page. The virtualizer owns
the full row count and requests missing pages as their indexes enter the
viewport or overscan range.

This is still pagination, but it is random-access pagination designed for a
virtual list rather than a forward-only feed.

### Reuse the generic virtual-list foundation

`WorkflowList.tsx` demonstrates the correct rendering pattern: it passes a
parent-owned scroll-container ref to `VirtualizedDropdownList`, which delegates
to the measured `VirtualizedList` built on `@tanstack/react-virtual`.

Workspace browsers should reuse/generalize `VirtualizedList`, not copy the
workflow-dropdown wrapper. `VirtualizedDropdownList` assumes a dense in-memory
array and dropdown-specific thresholds; a paged directory needs:

- a total row count larger than the loaded item count;
- placeholders for unloaded indexes;
- visible/overscan range notification so the caller can request pages; and
- a fixed workspace-entry height estimate with measurement correction.

Extend the shared primitive with a sparse/range data-source mode or add a thin
`VirtualizedPagedList` beside it while extracting common TanStack wiring. Do not
duplicate the parent-ref readiness fix, focus retention, measured row handling,
or key/scroll anchoring already solved in `VirtualizedList`.

### Page metadata, never content

Use a default page size of 250 entries and clamp client requests to a server
maximum of 500. Keep these values in named shared/server constants and tune them
only after profiling actual payload sizes and mobile scrolling.

A page contains `WorkspaceEntry` metadata only. Even if a directory contains
100,000 files, no file body is returned until one file is opened through the
existing file endpoint.

### Keep a manual recovery affordance

Pages should prefetch automatically as the user scrolls. If a page request
fails, preserve already loaded rows and show an inline Retry/Load page action
for the failed range. Automatic loading must not create an inaccessible dead
end or an infinite retry loop.

A subtle progress status such as `Loaded 500 of 12,430` is useful while pages
are arriving and makes the formerly silent boundary observable. Do not add a
“Load all into the DOM” action; reaching every row and mounting every row are
different goals, and virtualization deliberately avoids the latter.

## API Contract

### Initial listing request

Expand the tree API to accept a serializable request shape represented in
`HostedWorkspaceViewerTypes.ts` and encoded by `hostedApi.workspaceTree()`:

```ts
interface WorkspaceTreePageRequest {
  path: string;
  pageSize?: number;
  includeGitIgnored: boolean;
  anchorPath?: string;
}
```

This pagination stage preserves the current Name-ascending order. The sorting
plan later extends this initial request with `sort: WorkspaceEntrySort`; range
requests inherit the immutable order captured by `listingId`.

The first request has no listing id. The server resolves and validates `path`,
constructs one ordered snapshot of that directory, and returns a page at offset
zero. When `anchorPath` names an immediate child, return the page containing
that child instead; this lets Sync Explorer reveal the selected file without
downloading every earlier page.

### Range request

Subsequent requests identify the immutable snapshot and a page-aligned offset:

```ts
interface WorkspaceTreeRangeRequest {
  listingId: string;
  offset: number;
}
```

Use one endpoint with mutually exclusive initial/range query parameters or two
explicit routes if route parsing is clearer. Do not accept a client-provided
absolute directory path on range requests; `listingId` resolves only to a
workspace-scoped snapshot already admitted through `safeResolve()`.

The effective page size is fixed when the initial listing is created. The
server clamps the requested value once, stores the result in the snapshot, and
requires every range offset to align to that value. Range requests do not
renegotiate page size; otherwise the same listing could produce overlapping
pages and the sparse client map would have no stable page boundaries.

### Response

Replace/extend `WorkspaceTreeResponse` with a paged response:

```ts
interface WorkspaceTreePageResponse {
  listingId: string;
  pageSize: number;
  rootLabel: string;
  path: string;
  parentPath: string | null;
  isGitRepo: boolean;
  isRootsList: boolean;
  totalEntries: number;
  offset: number;
  entries: WorkspaceTreeEntry[];
}
```

`entries[i]` corresponds to virtual index `offset + i`. `totalEntries` is the
post-filter count for the requested view, so the explorer can size its virtual
list and accurately report progress. A page that reaches the end simply has
`offset + entries.length === totalEntries`; a separate `hasMore` flag would be
duplicate state. `pageSize` is the server-clamped size fixed for this listing;
returning it is required for clients to align later ranges, including when the
initial response is an anchored final page whose entry count is smaller than
the configured page size.

All paths remain normalized workspace-relative viewer paths, including
folder-name prefixes in multi-root workspaces. The virtual roots list uses the
same contract even though it will almost always fit in one page.

## Server Listing Snapshots

### Snapshot contents and ordering

On an initial request, create a snapshot containing the ordered immediate
children and the navigation metadata required by every page. It must never
contain file bodies.

For Name sorting:

1. `readdir({ withFileTypes: true })` once;
2. apply entry-kind and requested git-ignore filtering;
3. sort the lightweight names with directories first; and
4. stat only the page ranges that are actually requested, using each stat for
   both `size` and `modifiedAt`.

For Date modified sorting from `FILE_BROWSER_SORTING_PLAN.md`:

1. enumerate and filter once;
2. stat every immediate entry because modification time is the sort key;
3. use bounded concurrency rather than one unbounded `Promise.all`; and
4. sort the resulting metadata once, with directories first and the shared
   deterministic name tie-breaker.

This distinction keeps the common Name path cheap while accepting the
unavoidable metadata cost of a globally correct Date modified sort. Directory
metadata collection is still non-recursive; sorting a directory never reads
descendants or file contents.

### Snapshot identity and lifetime

Generate opaque, unguessable listing ids (for example `crypto.randomUUID()`). A
snapshot records its canonical resolved directory, viewer path, ordering/filter
options, ordered lightweight entries, creation time, and last-access time. The
pagination stage records the default Name-ascending order; the sorting plan adds
the selected key/direction to that identity.

Manage snapshots in a bounded LRU/TTL cache owned by
`HostedWorkspaceViewerService`:

- expire idle snapshots after a short interval (recommend five minutes,
  refreshed on every successful page access);
- cap the number/estimated metadata bytes of retained snapshots by evicting
  least-recently-used snapshots, not by truncating a directory;
- clear snapshots when the hosted service is disposed; and
- optionally evict snapshots for paths affected by save/delete/copy/move
  operations to reclaim memory early.

Treat the metadata-byte limit as a soft aggregate target, not a per-directory
product cutoff. Evict older snapshots until the newest snapshot is the only
one left, but retain that newest snapshot even when it alone exceeds the target;
otherwise one sufficiently large directory would create a listing id that is
already expired before its second page can be requested. Keep the count and
byte targets in named server constants so profiling can tune them without
changing the paging contract.

The current implementation already materializes every `Dirent` before slicing,
so one active snapshot does not introduce a new order of memory growth. The
cache bound prevents navigation history and multiple browser tabs from
retaining that cost indefinitely.

### Consistency and expiration

Pages from one listing id are an immutable view. Files created, removed, or
renamed after the initial request appear on Refresh or a new navigation, not
halfway through the current page sequence. This prevents offset duplicates and
omissions while the user scrolls.

Return a distinguishable expired-listing response (HTTP 410 is appropriate)
when a snapshot is evicted. The client should create a new listing anchored on
the top visible entry path and restore the viewport. Permit one automatic
restart per expiration event; repeated failure becomes the inline Retry state.
The shared hosted API error must retain the HTTP status (rather than exposing
only a formatted message) so the hook can distinguish 410 from ordinary page
failures without parsing strings.

Malformed ids, negative/non-aligned offsets, and out-of-range page sizes are
validated before access. Range responses must never expose absolute paths or
let a listing id cross workspace/service boundaries.

## Client Data Model

### Shared paged-directory controller

Both current consumers duplicate `workspaceTree()` loading, path normalization,
loading/error state, and directory navigation. Introduce a shared hook such as
`usePagedWorkspaceDirectory()` that owns:

- listing id and navigation metadata;
- total entry count;
- sparse pages keyed by offset;
- in-flight and failed page ranges;
- request generation/`AbortController` guards;
- initial load, anchored load, Refresh, and page retry;
- range prefetch driven by the virtualizer; and
- snapshot-expiration recovery.

The hook returns a sparse index accessor instead of repeatedly flattening pages
into new arrays. This keeps `estimateSize` and item lookup O(1), which the
existing virtualization guidance requires.

Navigation, git-ignore setting changes, and Refresh each start a new request
generation; sort changes join that list when the sorting plan lands. Abort old
requests and ignore any response whose generation, path, listing id, or listing
options no longer match. A slow page from the previous directory must never
append into the current directory.

`explorerEntries` is currently read only by `WorkspaceExplorerPane`. During
implementation, either replace it with the shared hook's listing state or make
the store own the paged structure and have the hook adapt it. Do not retain both
a flattened store copy and hook-owned pages as competing sources of truth.

### Range fetching

The paged virtual list reports its visible plus overscan indexes. Convert those
indexes into page-aligned offsets and request each missing page once. Prefetch
one adjacent page in the scroll direction when network conditions permit.

Render stable-height skeleton rows for unloaded indexes so the scrollbar and
scroll anchor do not jump when data arrives. Keys for loaded rows use normalized
entry paths; placeholder keys use listing id plus index. When a placeholder is
replaced, keep the row estimate identical so measurement does not move later
rows.

Small directories may render directly after the first response. Once
`totalEntries` reaches the shared virtualization threshold, use the virtual
path even if only one page is currently loaded.

### Explorer-specific behavior

`WorkspaceExplorerPane` must preserve:

- selected-file highlighting;
- Sync Explorer, using `anchorPath` for a selected file outside the first page;
- git status coloring;
- cut/copy/paste/delete context menus and refresh-after-mutation;
- hidden-gitignored behavior; and
- mobile editor navigation.

Pass `includeGitIgnored: !hideGitIgnoredFiles` on the initial listing so hidden
entries do not consume pages or create apparently empty ranges. Toggling the
setting starts a new listing. Keep `workspaceStatus()` aggregate and unpaged;
this plan does not alter SCM status semantics.

After a successful save or file operation, start a fresh listing anchored on
the affected/selected entry where it still exists. This also refreshes
modification times for Date modified sorting.

### Picker-specific behavior

`FileBrowserModal` uses the same hook and virtual list but keeps its existing
selection rules:

- directories are always navigable;
- file-filter mismatches remain visible but dimmed/unselectable;
- directory mode leaves file rows unselectable; and
- confirmation still returns only a workspace-relative path.

The picker passes `includeGitIgnored: true`, matching its current behavior. A
file filter does not reduce server pages because nonmatching files are
intentionally displayed rather than hidden.

## Coordination with File Browser Sorting

This plan is a prerequisite for
[`FILE_BROWSER_SORTING_PLAN.md`](./FILE_BROWSER_SORTING_PLAN.md) and must be
staged first. Do not implement the sorting plan against the current capped,
dense entry array.

The shared persisted sort preference and header UX from the sorting plan remain
valid. The selected sort key/direction becomes part of the initial listing
request, the server orders the complete snapshot, and changing a header starts
a new paged listing. This prevents loaded rows from reshuffling as additional
pages arrive and makes newest/oldest sorting globally correct for the current
directory.

This plan owns range contracts, snapshots, virtualization, and removal of the
fixed cap. The sorting plan owns modification metadata, complete-snapshot
comparators, the persisted preference, headers, and date-column presentation.

## Recommended Cross-Plan Order

Use this order for the two initiatives:

1. Stage the paged tree contracts and server-side listing-snapshot foundation,
   preserving Name ascending as the default order and returning metadata only.
2. Stage shared sparse-list virtualization and the paged-directory controller,
   migrate both browser surfaces, and then remove `MAX_ENTRIES`.
3. Stage the sorting contract and modification metadata, and globally order
   complete server snapshots with bounded stat concurrency.
4. Stage the shared persisted sort preference, headers, date column, consumer
   wiring, and sorting-focused tests.

Steps 1-2 belong to this plan. Steps 3-4 belong to the sorting plan. They may
ship in one coordinated initiative, but their dependency direction stays the
same.

## Implementation Phases

### Phase 1 — Paged contracts and snapshot service

1. Add shared initial/range request and page-response types.
2. Add the git-ignore filter to the initial request and keep the contract ready
   for the sorting plan's later `sort` field.
3. Build a workspace-scoped listing snapshot cache with TTL/LRU eviction.
4. Implement page-aligned random-access ranges and anchored initial pages.
5. Preserve the current plain Name-ascending behavior as the default contract.
6. Remove `MAX_ENTRIES` only after the paged response path is covered by tests.

### Phase 2 — Generalize virtualization

1. Extend `VirtualizedList` or add a shared sparse-page adapter that supports a
   total count, placeholder rows, and visible-range callbacks.
2. Preserve the existing parent-owned-ref readiness and focus-retention logic.
3. Add tests for sparse pages, far scrollbar jumps, placeholders becoming
   loaded rows, and callbacks not firing duplicate range requests.
4. Keep `WorkflowList` and `RunPanel` behavior unchanged through the refactor.

### Phase 3 — Shared paged-directory hook

1. Implement request generation, page maps, O(1) index access, loading/error
   ranges, Refresh, and expiration recovery.
2. Add anchored listings and scroll restoration.
3. Add progress and retry state suitable for both consumers.
4. Remove or reshape `workspaceViewerStore.explorerEntries` so there is one
   source of listing truth.

### Phase 4 — Migrate both consumers

1. Migrate `WorkspaceExplorerPane` and verify all navigation/context-menu/save
   flows against paged data.
2. Migrate `FileBrowserModal` and verify file/directory/filter selection flows.
3. Add automatic viewport-range loading plus the explicit retry affordance.
4. Confirm both surfaces show directories with more than 1,000 entries through
   the same shared implementation.

### Handoff to the sorting plan

After Phase 4, stage Steps 3-4 from the cross-plan order. The paged initial
request and snapshot identity should be ready to accept ordering parameters,
but modification metadata, non-default comparators, and sort UI are delivered
by `FILE_BROWSER_SORTING_PLAN.md`.

## Test Plan

### Server tests

Extend `HostedWorkspaceViewerService.test.ts` to cover:

- a directory with more than 1,000 entries is fully represented by
  `totalEntries` and every index can be paged;
- collecting all pages produces no omissions or duplicates;
- page sizes are clamped and offsets are validated;
- anchored initial requests return the page containing the requested child;
- default Name ascending order remains correct across page boundaries;
- directories stay ahead of files in the default order;
- include/exclude-gitignored counts and ranges are correct;
- multi-root virtual listings use the same response contract;
- expired/unknown listing ids produce the explicit expiration response;
- one snapshot remains consistent across filesystem mutations, while Refresh
  creates a new view; and
- metadata stat concurrency never exceeds the configured bound.

Add focused hosted-server route tests for query parsing, page-size clamping,
and 400/410 behavior where the existing test harness permits.

### Shared virtualization/hook tests

- Only viewport/overscan rows mount for a very large total count.
- The visible range requests the correct page-aligned offsets.
- Dragging/jumping near the end requests the final range directly.
- Multiple renders/scroll events do not duplicate an in-flight request.
- Placeholder replacement preserves scroll position.
- Focused rows remain mounted according to the existing focus rule.
- Path/sort changes ignore stale page responses.
- An expired listing restarts once around the top visible anchor.
- A failed page preserves loaded rows and exposes Retry.

### Component tests

For both `WorkspaceExplorerPane` and `FileBrowserModal`:

- fixtures larger than the old cap can reach a row past index 1,000;
- only a bounded number of row DOM nodes are mounted;
- navigation resets the listing and old responses cannot leak in;
- selection and keyboard/touch interaction work on later pages; and
- loading a tree page never invokes `workspaceFile()`.

Explorer tests additionally cover Sync Explorer to an anchored later page,
git-ignore toggling, context-menu refresh, and save refresh. Picker tests retain
file-filter and directory-mode coverage on later pages.

### Performance/manual verification

Generate disposable test directories with approximately 1,000, 10,000, and
100,000 immediate entries and profile:

- first-page latency and payload bytes;
- server heap retained per active snapshot and after TTL eviction;
- maximum concurrent stats;
- browser DOM row count;
- scroll-frame responsiveness on mobile and desktop; and
- random scroll jumps, sorting changes, Refresh, and snapshot expiration.

The acceptance criterion is reachability and bounded work, not that a 100,000
entry directory is instant. The UI must stay responsive, disclose loading, and
eventually render every requested range without a fixed product cutoff.

Run:

```text
npm run typecheck
npm run test:ui
npm test
npm run format:check
```

## Security and Resource Guardrails

- Keep initial paths behind the existing symlink-aware `safeResolve()` boundary.
- Keep listing ids opaque, workspace/service scoped, and short-lived.
- Clamp page size and validate integer offsets server-side.
- Use bounded stat concurrency; never replace the old cap with an unbounded
  `Promise.all` over an arbitrary directory.
- Bound cached snapshots by idle lifetime and aggregate memory, evicting
  snapshots rather than silently dropping their rows.
- Never store or return file contents in a listing snapshot.
- Preserve normalized workspace-relative paths in every response.

## Non-Goals

- Recursively flattening a repository. Paging applies to the immediate children
  of whichever directory the user opens.
- Loading every entry eagerly when the directory opens.
- Mounting every entry in the DOM or adding a “disable virtualization” option.
- Streaming or virtualizing the contents of a single opened file.
- Changing the existing 2 MB/binary file-open safeguards.
- Adding symlink browsing. The current tree accepts real files/directories and
  omits other `Dirent` kinds; changing that security-sensitive behavior is
  separate work.
- Paginating SCM status or workspace-search results.

## Completion Checklist

- [ ] No fixed entry-count cutoff remains in directory browsing.
- [ ] The tree API exposes stable snapshot ranges and an exact total count.
- [ ] Every page contains metadata only; file contents remain click-to-load.
- [ ] Large directory rows use the shared TanStack virtualization foundation.
- [ ] Scrolling or jumping requests only the missing visible/nearby ranges.
- [ ] Sync Explorer can reveal a selected entry outside the first page.
- [ ] Both browser surfaces share the paging controller and virtual list.
- [ ] Loading, progress, retry, refresh, and expired-snapshot states are visible
      and recoverable.
- [ ] The listing contract/snapshot identity is ready for the sorting plan to
      add server-wide ordering without changing the paging model.
- [ ] Git-ignore and picker-filter semantics are preserved.
- [ ] Tests cover directories beyond 1,000 entries and prove bounded DOM/network
      work.
