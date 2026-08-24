# Multi-Lane Commit Graph for the Workspace Source Control Pane

> **Status:** In progress — the pure layout algorithm and unit tests are implemented;
> rendering integration remains. Written 2026-08-24 against current code.
>
> **Problem in one line:** `WorkspaceCommitHistoryPane` draws one straight
> gutter line with a node per commit; it has no concept of branch lanes, so a
> history with merges (which `WORKTREE_SUPPORT_PLAN.md`'s managed/named
> worktrees make a normal, frequent shape — every worktree run lands as a
> branch that gets merged back) renders as a single column that cannot show
> where a branch forked or rejoined.

---

## 1. Current baseline (verified against `main`)

- `WorkspaceCommitHistoryPane.tsx:227-281` (`CommitGraphGutter`) renders a
  fixed `w-5` column: a top/bottom connector line and one circle per commit.
  There is exactly one lane. `isMerge` is used only to draw a static ring
  around the node — it does not fork the line.
- The server already computes everything a real graph needs but throws most
  of it away before it reaches the client:
  - `GitUtils.getRecentCommits()` (`src/utils/GitUtils.ts:112-171`) runs
    `git log --format=%H%x00%h%x00%s%x00%an%x00%ar%x00%P%x00%D -n <limit>
[--skip=N] [-- <ref>]` and already parses `%P` into `parentHashes: string[]`
    and `%D` into `refNames: string[]` on every `CommitInfo`.
  - `HostedWorkspaceViewerService.getCommitLog()`
    (`src/server/HostedWorkspaceViewerService.ts:1701-1772`) only uses
    `parentHashes.length > 1` to set `isMerge: boolean` and then drops the
    array. The full parent-hash list never reaches the wire.
  - `WorkspaceCommitLogEntry` (`src/types/HostedWorkspaceViewerTypes.ts:275-287`)
    has no `parentHashes` field, so there is currently no way for the client
    to know _which_ commit is a node's parent, only that it has &gt;1.
- The log walk is single-ref: no `ref` argument means "walk from HEAD";
  `WorkspaceSourceControlPane.detachedBranchHint()` supplies the previous
  branch name while detached so its newer commits stay visible
  (`WorkspaceSourceControlPane.tsx:41-44`, `getCommitLog`'s `branchHint`
  param). `git log <ref>` without `--first-parent` already walks _every_
  reachable ancestor via _every_ parent link and returns them in commit-date
  order — i.e. the exact input shape a swimlane algorithm expects. **No
  `--all` / multi-ref walk is needed for the case this plan targets**
  (a branch's merged-in history), only for showing several simultaneously
  checked-out branches side by side, which is explicitly out of scope (§7).
- Pagination is `skip`/`limit` based (`getCommitLog(skip, limit, branchHint,
repoId)`, 30 at a time via `loadMoreHistory` in
  `WorkspaceSourceControlPane.tsx:167-189`). The store
  (`workspaceViewerStore.ts:653-671`) keeps one flat, ever-growing
  `commitHistory: WorkspaceCommitLogEntry[]` and appends on "load more" — it
  never re-fetches or reorders already-loaded rows.
- Ref pills (`RefPill`, `WorkspaceCommitHistoryPane.tsx:283-315`) and their
  classification (`classifyRefNames`, `HostedWorkspaceViewerService.ts:~215`)
  are unaffected by this plan and stay as-is.
- Graph colors are already themed off VS Code's SCM palette in
  `src/ui/webview-react/tailwind.config.js:245-252` (`scm-graph-local` / `-remote` / `-base` →
  `var(--vscode-scmGraph-historyItem*Color, <hex fallback>)`), so hosted
  (non-VS Code) rendering already has real fallback colors, not just
  `undefined` CSS vars.

## 2. What VS Code does (read directly, not from memory)

VS Code ships a **hand-rolled, dependency-free** graph — it is not using
`gitgraph.js`, `d3`, or any npm graph library. It lives at:

- `src/vs/workbench/contrib/scm/common/history.ts` — types
  (`ISCMHistoryItem`, `ISCMHistoryItemGraphNode`, `ISCMHistoryItemViewModel`).
- `src/vs/workbench/contrib/scm/browser/scmHistory.ts` — the layout algorithm
  (`toISCMHistoryItemViewModelArray`) and the SVG renderer
  (`renderSCMHistoryItemGraph`).

The model, in our terms:

- Each **swimlane** is `{ id: <parent commit hash the lane is waiting for>,
color }`. A row's `inputSwimlanes` is the _previous_ row's `outputSwimlanes`
  (deep-cloned) — the whole thing is one linear left-to-right fold over the
  commit list, no lookahead required beyond "does this row's commit id match
  a lane I'm already tracking."
- For each commit, in list order:
  1. `inputSwimlanes = previousRow.outputSwimlanes` (or `[]` for the first row).
  2. Find the commit in `inputSwimlanes` by id → that lane's column is where
     the node is drawn (`circleIndex`); if not found, it's a new tip and gets
     appended as a new lane at the end.
  3. Build `outputSwimlanes` by walking `inputSwimlanes` left to right: any
     lane _not_ pointing at this commit passes through unchanged; the lane
     that _does_ point at this commit is replaced by one lane per parent
     (first parent reuses the same column/color, additional parents —
     merges — get a **new** column and a color pulled from a small rotating
     palette, `colorRegistry` = 5 colors, via `rot(colorIndex + 1, 5)`).
  4. Any parent id that a _later_ row will need to terminate onto is found via
     `findLastIndex(outputSwimlanes, parentId)` when that row is processed —
     this is how a branch's line curves back and joins an existing lane
     instead of running forever in its own column.
- Rendering (`renderSCMHistoryItemGraph`) is one `<svg>` per row, `SWIMLANE_WIDTH
= 11px` per lane, `SWIMLANE_HEIGHT = 22px` tall, columns at `x = WIDTH *
(laneIndex + 1)`. Per row it draws: straight verticals for lanes passing
  through untouched, quarter-circle-arc "elbows" (`A r r 0 0 1 …`) for a lane
  merging into the node's column or forking away from it, extra elbow pairs
  for each additional merge parent, and the node itself (filled circle, ring
  for the current HEAD, concentric ring for a merge commit).
- Colors are otherwise **not** semantically tied to specific branch names —
  VS Code has an optional `colorMap` for refs with a user-assigned color, but
  falls back to the same 5-color rotation for everything else. There's also
  an "incoming/outgoing changes" pseudo-commit-node feature layered on top
  (`addIncomingOutgoingChangesHistoryItems`) for their push/pull preview —
  not relevant here; ctrlyoke's ahead/behind is already a plain badge count
  (`WorkspaceCommitArea` props `incomingCommitCount`/`outgoingCommitCount`),
  and this plan doesn't change that.

**Decision: port this algorithm, don't pull in a library.** Reasons:

1. It's ~150 lines of pure, dependency-free array logic (`scmHistory.ts:292-407`
   for layout, `:124-275` for SVG) — smaller than most graph libraries'
   integration surface, and it's already proven against exactly the git
   semantics we use (merges, detached HEAD, decorations).
2. It's designed around **incremental, paginated, single-ref logs** — the
   same shape `getCommitLog`'s `skip`/`limit` already produces. A generic
   library (e.g. `@gitgraph/js`) expects a full commit set up front and
   owns its own DOM/canvas rendering; we'd fight it for both incremental
   loading and Tailwind/codicon styling. `git-graph.js`-style tools that
   ship as an installed VS Code _extension_ are also not a runtime
   dependency we can import — they're standalone webviews with no exported
   library entry point.
3. No new npm dependency to vet, license, or keep patched, and the output
   integrates directly with the existing `RefPill`/row-selection/context-menu
   code instead of a second component tree.
4. Algorithms aren't copyrightable; we're not vendoring VS Code source
   (MIT-licensed, so we _could_), we're independently implementing the same
   well-known swimlane technique against our own types, row markup, and color
   tokens.

## 3. Data model changes

Thread `parentHashes` through the one place it's currently dropped:

`WorkspaceCommitLogEntry` (`src/types/HostedWorkspaceViewerTypes.ts:275-287`):

```typescript
export interface WorkspaceCommitLogEntry {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  relativeDate: string;
  isHead: boolean;
  pushed: boolean;
  refs: GitRefLabel[];
  isMerge: boolean;
  /** Parent commit hashes, in git's order (first parent first). Needed to
   *  build the multi-lane graph; empty for the repository's root commit. */
  parentHashes: string[];
}
```

`HostedWorkspaceViewerService.getCommitLog()` (`:1759-1769`): add
`parentHashes: c.parentHashes` to the mapped object — `c` (the `CommitInfo`
from `getRecentCommits`) already has it, this is a one-line addition, no new
git call.

Keep `isMerge` as-is (still convenient for the row's `title` tooltip and any
non-graph code); it becomes derivable (`parentHashes.length > 1`) but there's
no reuse win worth removing a stable public field for.

No schema (`schemas/*.json`) changes — this type isn't part of
`workflow-schema.json`; it's a server↔webview wire type only. Update
`src/test/unit/HostedWorkspaceViewerService.test.ts` fixtures/assertions that
construct or check `WorkspaceCommitLogEntry` objects.

## 4. Layout algorithm (new module)

Implementation note: `commitGraphLayout.ts` follows the API and lane model below
without deviation. When converging lanes have the same target commit, the later
duplicate is removed when that commit is processed so the shared ancestor is
represented by one node and one continuing lane.

New file: `src/ui/webview-react/utils/commitGraphLayout.ts` — pure, no React,
independently testable.

```typescript
export interface CommitGraphLane {
  /** Hash of the commit this lane is waiting to reach. */
  id: string;
  /** One of a small fixed color-token rotation (see §5). */
  colorIndex: number;
}

export interface CommitGraphRow {
  /** Column index the commit's node is drawn in. */
  laneIndex: number;
  /** Lane state entering this row (top edges to draw). */
  inputLanes: CommitGraphLane[];
  /** Lane state leaving this row (bottom edges to draw). */
  outputLanes: CommitGraphLane[];
}

/** Builds one row per commit, in the same order as `commits`. Pure function
 *  of the full list — callers recompute on every change rather than
 *  threading incremental state (see §6 on why that's fine here). */
export function computeCommitGraphLayout(
  commits: readonly Pick<WorkspaceCommitLogEntry, "hash" | "parentHashes">[]
): CommitGraphRow[];
```

Body is the port of `toISCMHistoryItemViewModelArray`'s core loop (§2),
trimmed of the parts that don't apply:

- No `colorMap` parameter — always fall back to the rotating palette. Ctrlyoke
  has no per-ref color assignment feature and none is being added here.
- No `currentHistoryItemRef`/`Remote`/`Base` ref-sorting or
  incoming/outgoing pseudo-nodes — out of scope (§7).
- `references`/ref-pill handling stays exactly where it is today
  (`RefPill` in `WorkspaceCommitHistoryPane.tsx`); the layout module only
  produces lane geometry, not ref labels.
- A parent hash that never appears as a later row's `hash` (i.e. its commit
  hasn't loaded yet — the common case at the bottom of a page before "Load
  more" runs) simply becomes a lane that terminates unresolved at the last
  loaded row. Render it as a line running off the bottom edge rather than
  erroring; VS Code has the same boundary condition at the end of its loaded
  window.

## 5. Rendering

Replace `CommitGraphGutter` (`WorkspaceCommitHistoryPane.tsx:243-281`) with a
per-row SVG component, e.g. `CommitGraphSvg`, modeled on
`renderSCMHistoryItemGraph` (§2) but built with JSX (`<svg>`/`<path>`/`<circle>`
elements) instead of imperative DOM calls to fit the existing React component:

- Keep the existing per-node semantics (`isHead` ring, `ahead` hollow/dimmed
  style, merge-commit double ring) — they're currently expressed as Tailwind
  classes on a `<span>`; port them to SVG fill/stroke attributes driven by the
  same `relation`/`color`/`isHead`/`isMerge` props `CommitRow` already passes
  in.
- Row height: keep the existing `py-1` row rhythm (~22-24px), matching VS
  Code's `SWIMLANE_HEIGHT = 22`.
- Lane width: VS Code uses `11px`; ctrlyoke's mobile list view needs a
  slightly larger hit/visual target consistent with `min-h-[44px]` touch
  targets used elsewhere in this file for buttons — a value in the 12-16px
  range is a reasonable starting point, but pin the exact number by testing
  the desktop and mobile branch-heavy fixture from §8 rather than choosing
  blind.

### 5.1 Bounding lane width: the two-column "rail" layout

Resolved decision. Split each history row into two parallel columns instead
of the current single flex row (`CommitRow`'s `<button>` containing
gutter+subject+refs as siblings):

- **Graph rail** — the stacked per-commit `CommitGraphSvg` rows, wrapped in
  one container with `overflow-x: auto; overflow-y: visible` and a fixed
  pixel width capped to N inline lanes (see below). This is the _only_
  horizontally-scrollable thing in the pane.
- **Text column** — subject, ref pills, stage/discard/unstage buttons. No
  `overflow-x` of its own; never scrolls horizontally.

Both columns are children of one ordinary vertically-scrolling parent (the
existing `filesRegionClass`/`historyRegionClass` scroll areas in
`WorkspaceSourceControlPane.tsx`). Critically, **this needs no manual scroll
synchronization code**: because only the rail declares `overflow-x`, and
neither column declares its own `overflow-y`, the browser's native vertical
scroll on the shared ancestor moves both columns together for free — there
is no `onScroll` handler pairing two independent scroll positions, and thus
no drift/desync risk to test for. Horizontal drag only ever hits the rail's
own `overflow-x` region, so it's naturally scoped without extra gesture code
either (this also answers the mobile drag concern: a touch that starts in
the rail can pan vertically, which moves the shared ancestor and both
columns, and pan horizontally, which is absorbed by the rail's own
`overflow-x` and moves only the rail — exactly the "vertical always shared,
horizontal rail-only" behavior wanted, and it's what nested-overflow
containers do by default, not something we build).

Consequence for the DOM structure: a commit row can no longer be one
`<button>` spanning both columns (click-to-select, context menu, long-press
all currently hang off that single element in
`WorkspaceCommitHistoryPane.tsx:334-399`). Splitting rail and text into
separate trees means row height must stay pixel-identical between the two
(share one `ROW_HEIGHT` constant) and hover/selection styling must be driven
from shared state (`isSelected`, `commit.isHead`, index) applied
independently to both the SVG row and the text row, rather than relying on
one element's `:hover`/class list to cover both. This is bookkeeping, not a
design risk — the props needed (`isSelected`, `relation`, `color`, `isHead`,
`isMerge`) already flow into `CommitRow` today.

Inline lane cap: default to enough lanes to comfortably clear the common
case (a handful of concurrent branches) before the rail's own scroll kicks
in, and make the cap responsive — smaller on the `isMobile` layout
(`WorkspaceSourceControlPane.tsx:590-665`, where the pane is full viewport
width) than on the desktop side-by-side layout
(`WORKSPACE_VIEWER_SIDE_PANEL_*` sizing, `:667-691`). The first rendering pass
uses placeholder values of `14px` per lane, a five-lane desktop cap, and a
three-lane mobile cap (with `ROW_HEIGHT = 24px`). Tune these values against
the branch-heavy fixture in §8; they are intentionally not final.

Default `scrollLeft = 0` on the rail requires no extra logic to "do the
right thing": since commits list newest-first and the layout algorithm seeds
the first (most recent) row into lane 0, the trunk/HEAD lane always renders
at the rail's left edge — the unscrolled view already shows the mainline,
and scrolling right reveals side branches on demand.

## 6. Pagination interaction

`computeCommitGraphLayout` is called with `useMemo(() =>
computeCommitGraphLayout(commitHistory), [commitHistory])` in
`WorkspaceCommitHistoryPane`, recomputing the **entire** loaded list on every
change rather than threading incremental swimlane state across "Load more"
pages.

This is a deliberate simplification vs. VS Code (which also just recomputes
the full visible `viewModels` array on any change, `toISCMHistoryItemViewModelArray`
takes the complete `historyItems` list every call — it does _not_ do
incremental per-page folding either, despite the per-row loop internally
reading only the previous row). Given `commitHistory` here is capped by
realistic "load more" usage (tens to low hundreds of rows, not the tens of
thousands `git log --graph` might walk for `--all`), a full recompute is O(n)
over a small n and not worth the complexity of persisting/re-seeding lane
state across pages. Revisit only if a real workspace shows this is slow in
profiling — don't pre-optimize it.

## 7. Explicit non-goals (first pass)

- **`--all` / multiple simultaneously-visible branches.** This plan targets
  the case worktree merges actually create today: one branch's ancestry
  containing merged-in feature history. Showing several _currently checked
  out_ branches side by side (e.g. one lane per active worktree) is a
  materially different feature — different git walk (`--all` or explicit
  multi-ref), different ref-to-lane assignment, and a real question about
  how it interacts with `detachedBranchHint`'s single-hint model. Worth a
  follow-up plan if requested, not bundled here.
- **Per-ref explicit lane colors** (VS Code's optional `colorMap`, e.g.
  pinning `main` to a specific color). Rotation-only coloring is what VS
  Code falls back to for every repo without configured branch colors, and
  matches the second reference screenshot's actual behavior closely enough
  to start with.
- **Incoming/outgoing pseudo-graph-nodes.** Ctrlyoke's ahead/behind stays a
  plain count badge in `WorkspaceCommitArea`; no graph-embedded push/pull
  preview node.
- **Worktree-awareness inside the graph itself** (e.g. badging a ref pill
  with "checked out in worktree at &lt;path&gt;", using the already-existing
  `GitUtils.listWorktrees()`/`GitWorktreeEntry` from
  `WORKTREE_SUPPORT_PLAN.md`). Nothing in `HostedWorkspaceViewerService`
  currently calls `listWorktrees`; wiring worktree metadata into the SCM pane
  is a reasonable phase-2 idea but is independent of getting real graph lanes
  drawn, and should be scoped separately once this ships.

## 8. Testing

- `src/ui/webview-react/test/utils/commitGraphLayout.test.ts` (new): pure
  unit tests over `computeCommitGraphLayout`, ported from the _shape_ of
  `src/vs/workbench/contrib/scm/test/browser/scmHistory.test.ts`'s fixtures
  (linear history, a single merge, a criss-cross merge, an octopus merge,
  a branch tip with no children yet loaded) — assert lane indices and
  output-lane continuity directly rather than pixel output.
- Update `src/ui/webview-react/test/components/workspace-viewer/
WorkspaceCommitHistoryPane.test.tsx` for the new SVG row markup and to add
  a fixture with `parentHashes` describing an actual merge, so the test
  suite exercises multi-lane rendering, not just the single-lane case it
  covers today.
- Update `src/test/unit/HostedWorkspaceViewerService.test.ts` for the new
  `parentHashes` field on `getCommitLog()`'s response.
- Manual check: point the workspace viewer at this repository's own history
  (`git log` shows real merges from the branch list in the attached
  screenshot — `bug-fix`, `small-feature`, etc.) and at a worktree-heavy
  fixture repo with several managed-worktree merges, on both desktop and
  mobile widths.
