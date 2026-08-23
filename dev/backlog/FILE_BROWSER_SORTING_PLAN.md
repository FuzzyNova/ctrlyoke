# File Browser Sorting Plan

## Goal

Add consistent, visible sorting to every web-based workspace browser:

- `WorkspaceExplorerPane` in the hosted workspace viewer.
- `FileBrowserModal`, used by hosted-browser file and directory pickers.

The first release supports the four useful states requested:

- Name, ascending (A-Z).
- Name, descending (Z-A).
- Date modified, descending (newest first).
- Date modified, ascending (oldest first).

Every entry row shows its modification date and time even when the active sort
is Name. File size is deliberately deferred.

## Current Behavior

`HostedWorkspaceViewerService.listDirectory()` currently:

1. reads the directory with `readdir({ withFileTypes: true })`;
2. sorts directories by name;
3. sorts files by name;
4. concatenates directories before files;
5. limits the response to `MAX_ENTRIES` (1,000); and
6. stats only the returned files, currently to populate optional `size`.

Both `WorkspaceExplorerPane` and `FileBrowserModal` call the same
`workspaceTree()` API and render `result.entries` without further sorting.
They already share `EntryRow` and breadcrumb rendering through
`components/workspace-viewer/fileBrowserShared.tsx`, but each owns its own list
wrapper and loading/navigation state.

This means the current effective sort is directory names A-Z followed by file
names A-Z. There is no modification timestamp in `WorkspaceEntry`, so the
browser cannot display or sort on it yet.

## Product Decisions

### Keep directories grouped before files

All four sort states retain explorer semantics: directories appear first and
files second. The selected key and direction are applied independently within
each group.

This preserves the current navigation model and prevents a recently modified
file from burying every directory between files. At the virtual top level of a
multi-root workspace every item is a directory, so the same rule naturally
sorts the roots.

### Defaults and click behavior

The default remains Name ascending so the feature does not reorder the explorer
for existing users.

- Activating an inactive **Name** header selects Name ascending.
- Activating an inactive **Date modified** header selects Date modified
  descending, because finding recently changed files is the primary use case.
- Activating the already-selected header reverses its direction.

The active header shows an up/down chevron. The inactive header does not show a
misleading direction indicator.

### Share and persist one preference

Store one serializable sort preference in `uiStore`, for example
`workspaceEntrySort: { key, direction }`, and include it in `persistedFields`.
Both explorer surfaces read and update that value.

The sort is a user view preference, not workflow data and not file-editor
state, so it belongs in `uiStore` rather than `workspaceViewerStore`. Sharing
the value also avoids surprising changes between browsing in the workspace
viewer and opening a file picker. Reopening either surface restores the last
sort instead of resetting on every directory navigation.

Define the sort keys/directions as shared constants and derived union types
rather than repeating flow-control strings in components. The shared contract
should live with the workspace-tree types in `HostedWorkspaceViewerTypes.ts`
unless a broader application-wide sort contract appears during implementation.

### Use local time and handle missing metadata

Send modification time as epoch milliseconds (`modifiedAt?: number`), matching
the timestamp convention already used elsewhere in ctrlyoke. Format it in the
browser's locale with both date and hour/minute visible. Use a compact display
in the column and the full locale date/time in the row/header tooltip.

Modification time remains optional because filesystem stats can race deletion,
hit a permission error, or fail for a virtual root. A missing timestamp renders
as an em dash and always sorts after known timestamps in either direction.
Name is the deterministic tie-breaker for equal timestamps.

### Sort the returned page in v1

Sort client-side from the metadata already returned by `workspaceTree()`.
Header changes should be immediate and should not issue another HTTP request.
Directory navigation and Refresh continue to replace the entry set; the stored
sort is then reapplied through a memoized derived list.

There is one existing boundary to state explicitly: the server chooses and
returns at most 1,000 entries after its current directory-first/name ordering.
V1 sorts that returned page; it does not guarantee that “newest” finds an entry
outside the server's 1,000-entry window. Correct server-wide date sorting would
require server-side sort parameters or pagination plus bounded stat concurrency,
which is materially larger than this first pass. Add that only with pagination
instead of issuing an unbounded `stat` across enormous directories such as
`node_modules`.

## UX and Layout

Add a compact column-header row directly below each existing navigation header
and above its scrollable entry list:

```text
        Name                         Date modified  ↓
  📁    specs/                       8/21/26 4:18 PM
  📄    implementation-plan.md       8/22/26 9:42 AM
```

The header should scroll horizontally with neither surface. Use the same grid
tracks for the header and `EntryRow`:

1. fixed icon gutter;
2. `minmax(0, 1fr)` name column; and
3. a fixed or clamped date column wide enough for the chosen compact format.

Move `EntryRow` from its current flex layout to that shared grid rather than
independently approximating widths in both callers. Preserve name truncation,
git status color, selection state, cut opacity, context menu, long press, and
the existing mobile minimum row height.

For narrow panes, prioritize a useful filename while keeping both date and time
visible. Use a compact numeric date/time instead of hiding the column. The full
path remains available through the row title, and the full modification time
should be added to the accessible label/title.

The header controls are native buttons. Each exposes an accessible label that
states the key and current direction, `aria-pressed` for the active key, and a
decorative `aria-hidden` chevron. Preserve the existing `<ul>` entry semantics;
do not add table/grid roles unless the entry rows are converted into a valid
matching table/grid structure as part of a separate accessibility change.

## Recommended Architecture

### Shared contract and server metadata

Extend `WorkspaceEntry` in `src/types/HostedWorkspaceViewerTypes.ts` with:

```ts
/** Last filesystem modification time in epoch milliseconds. */
modifiedAt?: number;
```

Refactor `HostedWorkspaceViewerService.listDirectory()` so every returned entry
is statted at most once:

- files receive `size` and `modifiedAt` from the same stat;
- directories receive `modifiedAt` but no `size`;
- a stat failure still returns the entry with its metadata omitted; and
- the existing workspace containment, git-ignore calculation, directory-first
  ordering, and `MAX_ENTRIES` protection remain intact.

Also stat the backing directories used by `listRoots()` so multi-root entries
can display modification times. If a root disappears or cannot be statted,
return it with `modifiedAt` omitted instead of failing the complete virtual-root
listing. This will require making the virtual-root entry construction async or
having `listDirectory()` enrich those entries before returning them.

No new endpoint or message type is required. `workspaceTree()` already carries
the shared response unchanged.

### Shared sorting and presentation

Keep the behavior in `fileBrowserShared.tsx` (or small focused modules beside
it), not duplicated in the two consumers:

- `sortWorkspaceEntries(entries, sort)` returns a new array and never mutates
  Zustand/server-owned arrays.
- `nextWorkspaceEntrySort(current, requestedKey)` implements the default and
  toggle behavior once.
- `formatWorkspaceEntryModifiedAt()` owns compact visible formatting and the
  missing-value fallback.
- `FileBrowserSortHeader` renders the two aligned accessible header buttons.
- `EntryRow` renders the shared modified-time column.

Use a memoized `Intl.Collator` or the current `localeCompare` semantics for
names. Comparators must apply, in order:

1. directory-before-file grouping;
2. known-before-unknown for the selected key;
3. selected key and direction; and
4. ascending name as a deterministic tie-breaker for modified dates.

### Consumer wiring

`WorkspaceExplorerPane`:

- keep `explorerEntries` as the server snapshot in `workspaceViewerStore`;
- apply `hideGitIgnoredFiles` first and shared sorting second in `useMemo`;
- render `FileBrowserSortHeader` above the list; and
- after a successful file save, refresh the current directory metadata (or
  patch it from a richer save response) so the displayed modified time does not
  remain stale until manual Refresh. Reloading the current directory is the
  smaller v1 change and preserves the server as source of truth.

`FileBrowserModal`:

- derive sorted entries from its local `entries` plus the shared `uiStore`
  preference;
- retain directories regardless of `fileFilter`;
- retain the existing dimmed/unselectable behavior for non-matching files; and
- render the same header and row component as the explorer.

Filtering and git-ignore hiding do not change sort semantics. The explorer
filters hidden git-ignored entries before sorting; the picker continues to show
all entries and only changes eligibility/opacity for file filters.

## Implementation Phases

### Phase 1 — Metadata contract

1. Add optional `modifiedAt` to `WorkspaceEntry`.
2. Enrich returned files, directories, and multi-root virtual entries from
   filesystem stats without making a stat failure fatal.
3. Reuse one stat result per entry for file size and modification time.
4. Extend server unit tests for files, directories, ordering, virtual roots,
   and missing-stat tolerance where practical.

### Phase 2 — Shared sort preference and helpers

1. Define the sort constants/types and default `{ Name, Ascending }` value.
2. Add the shared preference and action to `uiStore` and persist it.
3. Implement the non-mutating comparator, toggle transition helper, and date
   formatter.
4. Unit-test all four states, directory grouping, timestamp ties, missing
   metadata, immutability, and default-direction transitions.

### Phase 3 — Shared header and row layout

1. Add `FileBrowserSortHeader` beside the existing shared browser primitives.
2. Convert `EntryRow` and the header to one aligned grid-track definition.
3. Add the compact date/time cell and full date/time/path tooltip or accessible
   label.
4. Verify selected, cut, disabled/dimmed, git-decorated, touch, and narrow-pane
   row states still render correctly.

### Phase 4 — Wire both browser surfaces

1. Derive filtered-and-sorted entries in `WorkspaceExplorerPane`.
2. Derive sorted entries in `FileBrowserModal` without changing picker
   selection or navigation behavior.
3. Render the shared header in both locations.
4. Refresh explorer metadata after a successful editor save.
5. Add focused interaction tests proving each surface reads and updates the
   same persisted preference.

## Test Plan

### Server/unit tests

Extend `src/test/unit/HostedWorkspaceViewerService.test.ts`:

- a file response includes `size` and `modifiedAt` from a controlled stat;
- a directory response includes `modifiedAt` and no file size;
- virtual multi-root entries include the backing root's modification time;
- existing directory-before-file and alphabetical default response behavior is
  unchanged; and
- a best-effort metadata failure does not drop or fail the directory listing.

Use controlled `utimes` values with tolerance for filesystem timestamp
precision rather than comparing wall-clock creation times.

### Shared UI unit tests

Add focused tests for the shared sort/list code:

- Name ascending and descending.
- Date modified newest-first and oldest-first.
- Directories remain grouped before files in every state.
- Missing timestamps remain last in both directions.
- Equal timestamps use ascending name order.
- Sorting does not mutate the input array.
- Inactive Name defaults to ascending; inactive Date modified defaults to
  descending; clicking the active key reverses direction.
- The active header exposes key/direction accessibly and the row exposes the
  displayed/full modification time.

### Component integration tests

Extend `FileBrowserModal.test.tsx` with timestamped fixtures and assert row order
before and after each header interaction while preserving file-filter and
selection behavior.

Add focused `WorkspaceExplorerPane` coverage (separate from its markdown-preview
tests) for:

- default ordering;
- switching to newest-first and reversing it;
- sorting after git-ignored filtering;
- selected/cut/status-decorated rows surviving reordering; and
- current-directory reload after a successful save.

Extend `uiStore` persistence tests to cover the sort preference and its default.

### Manual verification

- Hosted desktop: use both surfaces, switch all four sort states, navigate into
  several folders, refresh, and reopen the modal; confirm the shared preference
  remains active.
- Hosted mobile/narrow pane: confirm headers align with row cells, names remain
  usable, date and time remain visible, and long-press/context-menu behavior is
  unchanged.
- Multi-root workspace: sort the virtual roots list and a directory inside each
  root.
- Edit and save a file in the workspace viewer: confirm its displayed timestamp
  refreshes and it moves immediately when Date modified sorting is active.
- Confirm locale formatting in both 12-hour and 24-hour environments and check
  missing timestamps render as an em dash rather than an invalid date.

Run:

```text
npm run typecheck
npm run test:ui
npm test
npm run format:check
```

## Non-Goals

- File-size display or sorting.
- Recursive “most recently changed descendant” dates for folders. A folder row
  shows the filesystem modification time of that directory itself; it does not
  scan its subtree.
- Live filesystem watching. External changes appear after navigation or
  Refresh; saves made in the workspace viewer refresh explicitly.
- Changing native OS dialogs used by the VS Code panel.
- Server-side pagination or globally correct sorting beyond `MAX_ENTRIES` in
  v1.
- Changing file-filter or git-ignore semantics.

## Completion Checklist

- [ ] `WorkspaceEntry.modifiedAt` is populated for files, directories, and
      available virtual roots.
- [ ] Name and Date modified headers are shared by both browser surfaces.
- [ ] All four sort states work with directories kept before files.
- [ ] The default remains Name ascending and Date modified initially chooses
      newest first.
- [ ] Every row displays localized date and time, with an accessible full value
      and a safe missing-value fallback.
- [ ] One persisted `uiStore` preference drives both surfaces.
- [ ] Saving from `WorkspaceExplorerPane` refreshes the timestamp and active
      order.
- [ ] Server, shared utility, store, and both component paths have focused tests.
- [ ] The 1,000-entry v1 boundary is documented and no unbounded stat traversal
      is introduced.
