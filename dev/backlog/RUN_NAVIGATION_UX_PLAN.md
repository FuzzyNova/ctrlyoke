# Run Navigation and Run-Number Display

Status: **Proposed**

## Goal

Make the selected run part of the workflow's visible identity and move run
navigation out of the Output panel.

The workflow dropdown should present a lineage and its runs as one navigable
hierarchy that works equally well on desktop and mobile:

1. The header identifies the viewed workflow and viewed run (or draft)
   whenever the lineage has more than one addressable target; a single-run
   lineage renders exactly as today, so users who never re-run see no new UI
   anywhere.
2. Switching runs of the currently viewed workflow takes two clicks.
3. Any other lineage's runs are reachable from the workflow list.
4. A lineage with 1,000 runs mounts only the visible run rows.
5. Run labels use the manifest's monotonic `runId`; deletion gaps remain visible.
6. Navigation and mutations target stable `{ workflowKey, runRef }` addresses,
   never a list index or inferred “latest” run.
7. The Terminal tab continues to describe execution-owned terminals honestly;
   selecting a historical run does not imply that the terminal changed runs.

## Current problem

`RunSelector` still reflects the old output-history mental model:

- it is rendered only inside `OutputSectionHeader` and disappears on the
  Terminal tab;
- its trigger calculates a display number as
  `availableRuns - currentRunIndex`, which renumbers surviving runs after a
  deletion instead of using `RunSummary.runId`;
- it accepts parallel count/index/timestamp/state props even though `uiStore`
  already holds the manifest-backed `RunSummary[]`; and
- its popup renders all rows directly.

After the working-file-per-run work, selecting a run changes the definition,
steps, properties, output, save target, and continuation target together. Run
selection is workflow navigation now, not an Output-panel tool.

One current-behavior note for later sections: the workflow dropdown has **no
scroll-to-current logic today**. The viewed workflow merely appears near the
top because sorting is favorites-then-recency and the viewed lineage is almost
always the most recently modified. `VirtualizedDropdownList` has no
`scrollToIndex`; the run panel below is where that capability gets added.

## Decision: drill-in dropdown with dual triggers

The `WorkflowStatus` dropdown becomes one panel with **two views** — the
existing workflow list, and a per-lineage **run panel** that replaces the list
when the user drills into a lineage:

```text
Workflow list view                        Run panel view
[ Workflow8 · Run 12 · COMPLETED | ▾ ]    [ Workflow8 · Run 12 · COMPLETED | ▾ ]
[ Workflows [search] [filters]  [x] ]     [ ‹ Workflow8   ↑ newer ↓ older [x] ]
| Workflow2              Run 10 ▸   |     |   Draft                           |
| Workflow3                         |     |   Run 12    COMPLETED   5 min ago |
| Workflow4               Run 2 ▸   |     |   Run 11    COMPLETED   1 hr ago  |
| Workflow8              Run 12 ▸   |  →  |   Run 10    STOPPED     2 hrs ago |
| Workflow6                         |     |   Run  9    COMPLETED   yesterday |
| Workflow7                         |     |   Run  7    COMPLETED   yesterday |
```

The diagram is schematic — it elides the metadata cells to show structure.
Workflow rows keep **every cell they render today** (favorite, harness icon,
state badge, step count, relative time, terminal icon, remove action); see
“Workflow list view” below.

The run panel is a **flat, homogeneous, virtualized list** with a pinned
header row naming the lineage. There is no accordion, no flattened
mixed-kind row model, no sticky-parent virtualizer range, and no
deep-scroll collapse anchoring — the pinned header *is* the parent, natively,
and “collapse” is the back button restoring the workflow list.

### Why not the accordion (alternative considered)

An earlier draft of this plan expanded run children in place beneath their
workflow row (one virtualized accordion). It was rejected because:

- roughly a third of its spec existed to solve problems the accordion itself
  created: sticky-parent range inclusion, interactive-clone avoidance,
  deep-scroll collapse anchoring, and filter/expansion interaction;
- auto-expanding the displayed lineage on open pushed the workflow list — the
  dropdown's most common target — below hundreds of run rows; and
- it required a heterogeneous flattened row model and tree ARIA semantics
  where drill-in needs two ordinary listboxes.

Drill-in delivers the same navigation with a fraction of the UI machinery.
Its only real costs — other workflows are one back-click away while browsing
runs, and cross-lineage run comparison needs back-and-forth — are rare flows.

## Header identity and triggers

The `WorkflowStatus` split button gains a third segment. All three are sibling
native buttons (per the established sibling-button rule; a clickable badge
nested inside the rename button would be a button-in-button):

```text
┌─────────────────────────────┬──────────┬────┐
│ Workflow name    COMPLETED  │ Run 1042 │ ▾  │
└─────────────────────────────┴──────────┴────┘
        rename                 run panel   workflow list
```

- **Main segment** retains its current rename behavior.
- **Run identity badge** (`RunIdentityBadge`) shows the viewed run identity
  and opens the dropdown **directly in the run panel** for the displayed
  lineage. This is what keeps “switch run of the current workflow” at two
  clicks — the most common run action.
- **Chevron** opens the dropdown in the workflow list view, exactly as today.

Badge display rules:

- **Visibility: render the badge segment only when the lineage has more than
  one addressable target** (promoted runs plus draft, i.e.
  `runCount + (hasDraft ? 1 : 0) > 1`). A single-run lineage with no draft
  and a draft-only lineage show **no badge at all** — the header keeps
  today's two-segment shape, so users who never use re-run see exactly
  today's UI. There is no disabled-badge state; the badge either navigates
  or does not exist. This is the same visibility rule the workflow list's
  run indicator uses below — one rule, both surfaces.
- Resolve the label by matching `displayedViewAddress.runRef` against
  `runSummaries` and render the matching manifest `runId`. Never derive the
  number from array length or index.
- A draft displays `Draft` instead of a run number (shown only when at least
  one promoted run exists to navigate to).
- On narrow layouts, `Run 1042` becomes `#1042`; its accessible label and
  tooltip remain “Run 1042.” It stays a button at every tier.

Trigger semantics when the dropdown is already open (stateless and
predictable):

- Badge click: opens/switches to the run panel for the displayed lineage; if
  the run panel for that lineage is already showing, closes the dropdown.
- Chevron click: opens/switches to the workflow list; if the workflow list is
  already showing, closes the dropdown.
- Back `‹` in the run panel always goes to the workflow list — even when the
  user entered via the badge. The badge is a shortcut *into* the hierarchy,
  not a separate widget; users build one spatial model.
- Escape closes the dropdown outright from either view and restores focus to
  the trigger that opened it.

## Workflow list view

The workflow list keeps today's structure, search, and filters. **Workflow
rows render exactly the cells they render today** — name, favorite star,
harness icon, execution-state badge, step count, relative time, terminal
icon, and remove action — with all run-derived values mapped to the
lineage's primary address (latest run or draft), which is already where
today's `RecentWorkflow` fields come from. The run indicator described below
is the **only addition** to the row, and it appears only when the lineage is
drillable.

A lineage row gains a **run indicator cell** only when the lineage is
drillable — the same multi-target rule as the header badge:

- `Run N ▸` for a lineage with `runCount > 1` (or one run plus a draft),
  using the latest/default `RunSummary.runId`; or
- `Draft ▸` for a draft with at least one historical run.

A single-run lineage with no draft, a draft-only lineage, and a lineage with
no addressable definition show **no run indicator at all** — their rows
render exactly as today.

**Placement:** the run indicator sits immediately after the time column —
the last cell of the row's metadata cluster — and **before** the
hover-revealed favorite/trash actions, which keep today's positions at the
row edge:

```text
[icon] Name        4 steps   COMPLETED   5 min ago   Run 12 ▸   [★] [🗑]
```

Since favorite/trash are hover-revealed, the indicator is the rightmost
visible element at rest, reading as the row's drill affordance. Placing it
inside the actions cluster (next to the lineage-deleting trash) is rejected
for destructive-adjacency reasons. Narrow layouts render it as `#12 ▸`.

**Column reservation is list-scoped, not row-scoped:** when at least one
visible row is drillable, reserve the run-indicator track on every row
(empty for non-drillable rows) so the time/badge columns stay aligned across
rows. When no visible row is drillable, the track does not exist at all —
that is what keeps the never-re-run user's list pixel-identical to today.

**The empty track on non-drillable rows is deliberate, not a gap to fill.**
Empty-when-inapplicable is already this row's design language — the
terminal-icon track is empty on most rows, the harness span renders empty
without a harness, and step count renders empty at zero. Filler text for
single-run rows (e.g. an inert `1 run`) was considered and rejected: it
repeats a near-constant value across most rows, dilutes the scannability of
the sparse column (drillable lineages should pop), and mixes value types —
a count next to `Run 12 ▸` identities, misleading for a lineage whose only
surviving run is, say, Run 7.

The row's primary button keeps today's behavior: it selects the lineage's
default address and closes the dropdown, preserving the two-click workflow
switch. The run indicator is a **sibling native button** that drills into the
run panel without selecting or loading the workflow.

Row states that must stay visually distinct (not one `isSelected` flag):

- the displayed lineage;
- a running lineage; and
- a pending run-view target.

## Run panel view

### Pinned header row

The run panel's first row is pinned above the scrolling list (outside the
scroll container, like the workflow search header today):

```text
[ ‹  Workflow8            ↑ newer  ↓ older  [x] ]
```

- **Back `‹`** returns to the workflow list, restoring its previous scroll
  position and filter state.
- The lineage name identifies whose runs these are.
- **Newer/older** actions navigate to the adjacent run relative to the viewed
  run, resolving the adjacent summary to its stable `runRef` immediately
  before sending `LOAD_RUN_VIEW`. Disable the appropriate direction at either
  end. The draft counts as newest: “older” from the draft goes to the latest
  run, and “newer” from the latest run goes to the draft when one exists.
  With the badge one click away, prev/next run is two clicks total — no
  permanent header width is spent on it.
- Close `[x]` closes the dropdown.

### Rows

The list is the lineage's `RunSummary[]` in newest-first order. When the
lineage has a draft, a **`Draft` row appears at the top** as a peer of the
runs — draft and runs become one list, which also gives a draft-viewing user
a way back to any run and a run-viewing user a way to the draft.

Each run row uses manifest values directly:

```text
Run 1042   CODEX   COMPLETED   4 steps      5 minutes ago
```

Recommended cells:

- selected/live indicator;
- `Run ${summary.runId}`;
- primary harness/model, with the existing mixed-harness/mixed-model
  treatment;
- execution-state badge;
- step count; and
- relative start/completion time.

Narrow layouts progressively reduce metadata:

```text
#1042   ✓
```

The full run number, state, harness/model, steps, and time remain in the
row's accessible name and tooltip.

The row's primary button loads this exact address:

```ts
{
  workflowKey: summary.workflowKey,
  kind: "run",
  runRef: summary.runRef,
}
```

Selecting the **executing run's row** must reuse today's back-to-live path
(`clearHistoryOutputs`/`clearHistoryView`), not a `LOAD_RUN_VIEW` snapshot
fetch — the legacy `RunSelector` special-cased live-run selection the same
way, and loading a persisted snapshot of an actively streaming run would
present stale output.

The delete action is a sibling native button, targets `summary.runRef`, and is
unavailable for the executing or otherwise protected run.

### Footer

The run panel keeps the legacy selector's bulk-cleanup path as a
**Delete all runs** footer action. It sends the existing `CLEAR_RUN_HISTORY`
operation for the drilled lineage (all runs, not the lineage itself), is
gated by `confirmDeleteOperations`, and follows the same protected-run
exclusions as per-run delete (the executing run and any pending-rewind or
in-flight-transaction run survive).

Rows follow the existing dropdown-row conventions: non-focusable row
container, native primary button, sibling native action buttons, grid tracks
with the label in `minmax(0,1fr)`, and the measured usable-row-width lock
inside the scrollable container.

### Opening behavior

- Entering via the badge (or via a lineage whose run is currently viewed):
  highlight the viewed run's row and `scrollToIndex` it into view. The
  displayed lineage's summaries are already in `uiStore.runSummaries`, so no
  backend round trip occurs.
- Entering another lineage via its `Run N ▸` cell: show the pinned header
  immediately with a loading row, fire the summary-only request below, then
  replace with run rows or a clear empty/error row.
- Keyboard: Arrow Up/Down, Page Up/Down, Home, End traverse the run list;
  Left (or Backspace) triggers back; Enter selects. In the workflow list,
  Right on a row with a drill affordance drills in.

## One virtualized list per view

Both views are plain homogeneous lists over the same
`@tanstack/react-virtual` primitive `VirtualizedDropdownList` already wraps.
Extend it with the two capabilities the run panel needs:

- `scrollToIndex` for the selected/viewed row; and
- restoring a saved scroll offset (workflow list position on back).

Keys are stable identities — `run:${workflowKey}:${runRef}` and
`draft:${workflowKey}` for run-panel rows, the existing keys for workflow
rows. Never key by index; deletion and new-run arrival change indices
immediately.

No sticky-row support, mixed-kind row unions, or expansion-aware anchoring is
required.

## Expansion and summary loading

The displayed lineage already has `RUN_VIEW_LOADED.runSummaries`, so opening
its run panel requires no backend round trip.

Drilling into another lineage requires a request-correlated, summary-only
message. It occurs only after an explicit drill action, so there is no hover
flooding or debounce requirement.

Recommended contract:

```ts
interface LoadRunSummariesMessage {
  type: typeof MESSAGE_TYPES.LOAD_RUN_SUMMARIES;
  requestId: string;
  workflowKey: WorkflowKey;
}

interface RunSummariesLoadedMessage {
  type: typeof MESSAGE_TYPES.RUN_SUMMARIES_LOADED;
  requestId: string;
  workflowKey: WorkflowKey;
  descriptorRevision: number;
  lastModifiedAt: number;
  runSummaries: RunSummary[];
  executionRunRef?: RunRef;
}
```

The exact names may follow nearby contract conventions, but the operation must
remain summary-only. It does not register a new client view, switch an
instance, load a working file, read `events.jsonl`, alter the browser route,
or rebaseline editor/output state.

Cache successful summaries by `workflowKey` plus known
`lastModifiedAt`/descriptor revision for the lifetime of the webview.
Invalidate when newer lineage metadata arrives. Deduplicate repeated drill-in
while a request is in flight and correlate responses so a late result
populates only its keyed cache.

## Recent-workflow summary metadata

Workflow list rows need enough manifest metadata to show the correct run
number and whether a drill affordance is useful without loading all summaries.

Extend recent/running workflow row contracts with lightweight fields such as:

```ts
interface WorkflowRunNavigationSummary {
  primaryAddress: WorkflowViewAddress;
  primaryRunId?: number;
  runCount: number;
  hasDraft: boolean;
}
```

Use one shared type across extension/webview messages and stores rather than
adding parallel optional fields to `RecentWorkflow` and `WorkflowSummary`.

`GET_RECENT_WORKFLOWS` already reads each lineage descriptor and working file.
It may read the latest manifest and count valid manifests to populate this
summary, but it must not load definitions or timelines for every run. If
counting manifests is measurably expensive with many lineages, persist or
derive a repairable run count in the repository layer rather than caching an
unvalidated UI count.

## Search and filters

The existing search and filters belong to the workflow list view only. The
run panel has no search in the first delivery; scrolling is the required
navigation for a 1,000-run lineage. Exact run-ID search or type-to-jump may
be added later, but must filter or navigate the cached `RunSummary[]` by
`runId` while still selecting by `runRef`.

- Drilling in does not reset workflow search/filter state; back restores the
  workflow list exactly as it was, including scroll position.
- Filter state interacts with nothing in the run panel — the two views own
  disjoint state, which is most of the reason this design is simpler.

## Scaling to 1,000+ runs

### Rendering

At 1,000 summaries, keep the lightweight summary array in memory but mount
only visible rows plus overscan. Definitions and `events.jsonl` are not loaded
until a run is selected. The run panel is a flat list, so this is ordinary
virtualization — no novel capabilities beyond `scrollToIndex` and offset
restore.

### Payload and storage measurement

Keep complete summary arrays for the first delivery and measure with 1,000-
and 10,000-run fixtures. A thousand small manifest-only records is an
acceptable initial target; the likely costs are manifest scanning and
serialization, not React row count after virtualization.

Targets:

- opening the run panel with displayed-lineage summaries already cached
  becomes interactive within 100 ms;
- only visible rows plus overscan mount for 1,000 runs;
- switching a run does not regress existing run-view load time by more than
  10%; and
- a 10,000-summary response does not cause a visible multi-frame stall on
  supported desktop or mobile browsers.

If pagination becomes necessary, use a cursor keyed by
`{ workflowKey, beforeRunId? }`, never page numbers or indices. Retention and
deletion can change positions between requests.

## Terminal semantics

Remove run navigation from `OutputSectionHeader` rather than making it visible
on both tabs. The Terminal tab shows sessions owned by the executing workflow
run and does not change merely because the client views a historical run.

When the terminal's execution address differs from `displayedViewAddress`,
show the execution identity in the terminal context:

```text
Terminal · Live Run 1042
```

`WorkflowStatus` continues to show the viewed identity, for example
`Run 1031`. The two labels make the split explicit.

## Component and state changes

### Step 0: unify the running/recent sections

Today the dropdown renders two differently keyed sections —
`RunningWorkflowItem` keyed by instance UUID, `RecentWorkflows` keyed by
`workflowKey` — plus the `syntheticActiveWorkflow` special case in
`WorkflowStatus`. Compose these into **one lineage-level navigation model**
(one row per lineage, running state as row state, no lineage duplicated
across sections) before building the run panel. This is a prerequisite
refactor for the drill-in design, not a side effect: the run indicator cell,
drill affordance, and view-switch semantics all assume one row per lineage.

**Decided layout: one unified list, not two visual sections.** Running
lineages sort to the top with their live indicators and keep their inline
pause/resume/stop controls on the row. The bounded-scroll “Running
Workflows” section, its dedicated scroll container, and the
section-conditional search/close-button plumbing are removed along with the
section itself.

### `WorkflowStatus.tsx`

- Read `runSummaries`, `displayedViewAddress`, `executionRunRef`, and pending
  run-view state from `uiStore`.
- Resolve and render the actual manifest `runId` in the badge.
- Own ephemeral dropdown view state:
  `dropdownView: "workflows" | "runs"` plus `drilledWorkflowKey`, reset on
  close. This state is per-open-session and never persisted.
- Keep request correlation and loading feedback through
  `requestRunViewLoad`; do not create another run-selection path.
- Retain the responsive single-mount behavior in `Header.tsx` (one instance
  gated by `useMediaQuery`, never per-tier hidden copies).

### Workflow/run navigation components

Replace the trigger-oriented legacy `RunSelector` with focused pieces:

- `RunIdentityBadge` — the header's third split-button segment; displays
  viewed identity and opens the run panel;
- `RunPanel` — pinned header row plus the virtualized run/draft list for one
  lineage;
- `RunSummaryRow` — run-row presentation keyed by `runRef`; and
- `useRunSummaryCache` (or equivalent non-persisted store) — summary-only
  loading, request correlation, deduplication, and invalidation.

Extract shared harness, state, count, and time cells/helpers where the
workflow rows and run rows genuinely share semantics.

Do not preserve the legacy count/index component API under a new wrapper.
Components accept `RunSummary[]` and stable addresses.

### `OutputSectionHeader.tsx` and `OutputSection.tsx`

- Remove `RunSelector` and all run-selection props from
  `OutputSectionHeaderProps`.
- Remove OutputSection's run-selector popup-height observer/CSS variable if no
  other popup consumes it.
- Move the stable `LOAD_RUN_VIEW` sender into a shared navigation helper or
  `WorkflowStatus`; do not duplicate it.
- Keep output-specific undo/redo, diff, export, font, and execution-mode
  controls unchanged.

### `uiStore.ts`

`runSummaries` and `displayedViewAddress` remain the displayed lineage's
sources of truth. After all callers migrate, remove legacy derived fields if
unused:

- `availableRuns`;
- `viewingRunIndex`;
- `runTimestamps`; and
- `runStates`.

If another consumer needs a position, derive it from `runRef` at presentation
time. Never persist or send the position across the webview boundary.

Dropdown view state, drilled lineage, keyboard-active row, and the workflow
list's saved scroll offset are ephemeral per-open-session state. The summary
cache is non-persisted and keyed by lineage identity/revision; it is not
dashboard selection state.

## Accessibility and responsive behavior

- All triggers and row actions are sibling native buttons; no row is a
  focusable pseudo-button wrapping real buttons.
- Each view is an ordinary listbox/grouped list. No tree role is needed —
  the run panel's pinned header (`‹ Workflow8`) carries the hierarchy.
- The badge's accessible name states both identity and action, e.g.
  “Run 1042 — browse runs of Workflow8.”
- Switching views moves focus predictably: drilling in focuses the run list
  (or the viewed run's row); back focuses the row/affordance that initiated
  the drill, or the workflow list when entered via the badge.
- Escape closes the dropdown and restores focus to the opening trigger.
- High-contrast selection/hover uses `fp-dropdown-row` and
  `fp-dropdown-row-selected`.

The dropdown remains single-column and full-width/bottom-bounded on mobile.
Drill-in is inherently mobile-friendly — a full-panel view swap with a back
button — so no alternate mobile navigation model is necessary.

## Deletion and live-run behavior

- Delete by `{ workflowKey, runRef }`, never a list index.
- Keep inline confirmation inside the run row using sibling native buttons.
- An executing run shows its live indicator and cannot be deleted.
- If the deleted run was the lineage's latest, refresh the workflow row's
  `primaryAddress`, `primaryRunId`, count, and the run panel's rows from the
  authoritative response.
- If the viewed run is deleted by this or another client, retain the existing
  deterministic fallback (draft, newest remaining run, or unload lineage).
- If a new run appears while the panel is open, merge/replace summaries by
  `runRef`. Do not move keyboard focus merely because a newer row was
  inserted.
- A pending `LOAD_RUN_VIEW` highlights its target separately from the
  currently displayed address and ignores stale responses through the
  existing request ID.

## Test and acceptance matrix

### Identity and correctness

- Runs with IDs `[1042, 1040, 7]` display those exact numbers after deletion;
  no UI substitutes `3`, `2`, or `1`.
- Workflow rows display their actual latest/default `runId`; the viewed run's
  row retains its exact highlight in the run panel.
- Selecting, deleting, and newer/older-navigating a run sends its exact
  `runRef`.
- Draft, single-run, multiple-run, executing-run, historical-run, and pending
  run-view states render the correct identity and affordance (including the
  fully hidden badge/indicator for single-run and draft-only lineages).
- Switching runs preserves coherent definition/settings/output snapshots and
  existing stale-response protection.

### Drill-in interaction

- Badge click opens the run panel for the displayed lineage with the viewed
  run highlighted and scrolled into view, with no summary request.
- Chevron click opens the workflow list exactly as today.
- Drilling into another lineage performs at most one summary request and
  shows loading/empty/error rows correctly.
- Back restores the workflow list's scroll position and filter state.
- Clicking a workflow row's primary action still switches to it directly;
  clicking its run indicator drills in without loading it.
- A one-run lineage (no draft) shows no run indicator in the list and no
  header badge — its row and header are pixel-identical to the pre-feature
  UI. A drillable lineage's row differs from today **only** by the added run
  indicator cell; every existing metadata cell renders unchanged, mapped to
  the primary address. In a mixed list, non-drillable rows reserve the empty
  indicator track so time/badge columns stay aligned; in a list with no
  drillable rows the track is absent everywhere. A draft with historical
  runs can drill in and shows the draft row at the top of the panel.
- Trigger toggle semantics: badge closes an open run panel, chevron closes an
  open workflow list, and each switches views when the other view is showing.
- Closing and reopening resets to the entry view of whichever trigger was
  used.
- The unified workflow list sorts running lineages to the top with working
  inline pause/resume/stop controls; no lineage appears twice.
- Selecting the executing run's row returns to live output without a
  `LOAD_RUN_VIEW` round trip.
- Newer/older traverses draft ↔ latest run correctly when a draft exists.
- Delete-all-runs confirms (when `confirmDeleteOperations` is on), excludes
  protected runs, and refreshes the panel and workflow row metadata from the
  authoritative response.

### Scale

- A 1,000-run fixture mounts only visible rows plus overscan.
- Opening on a viewed run near the beginning, middle, or end scrolls it into
  view.
- Deleting rows and receiving new summaries retain stable keys and do not
  leak observers, listeners, or virtualizer measurements.

### Terminal clarity

- Viewing historical Run 1031 while terminals belong to live Run 1042 shows
  both identities in their respective contexts.
- Switching the viewed run does not relabel or rebind the active terminal as
  if it belonged to the historical run.

### Responsive/accessibility

- Narrow layouts render `#1042`, compact run rows, and one `WorkflowStatus`
  instance.
- Mouse, keyboard, and touch can drill in, go back, and select exact runs
  without hover-only behavior.
- Keyboard users can reach a virtualized off-screen viewed run, navigate back
  to the workflow list, and close with Escape, with focus restored at each
  step.
- Screen readers distinguish workflow rows, the run panel's lineage context,
  run rows, the draft row, exact selection, pending selection, and live
  execution.

## Delivery sequence

1. Unify the running/recent dropdown sections into one lineage-keyed row
   model rendered as a single list (step 0), preserving current
   switch/pause/resume/stop behavior on running rows.
2. Add the lightweight workflow-row run metadata and summary-only request
   pair, with repository/router isolation tests.
3. Add `RunSummaryRow`, `RunPanel`, and the `scrollToIndex`/offset-restore
   virtualizer capabilities, including 1,000-run coverage.
4. Implement the two-view dropdown state, lazy summary loading, drill/back
   navigation, and exact stable-address selection in `WorkflowStatus`.
5. Add the three-segment header with `RunIdentityBadge` as a run-panel
   trigger, including narrow `#1042` and the hidden state for single-target
   lineages (header collapses back to today's two segments).
6. Remove the legacy selector from `OutputSectionHeader`/`OutputSection`,
   delete its count/index props and popup-height plumbing, and remove obsolete
   store fields after a caller audit.
7. Add terminal execution-run labeling when viewed and executing addresses
   differ.
8. Run compile, typecheck, lint, formatting, and the full webview/extension
   test suites; manually exercise 1, 2, 1,000, and gapped run IDs across
   responsive tiers.
9. Measure manifest-summary generation and payload/application with 1,000 and
   10,000 runs. Add cursor pagination only if the targets above fail.

## Decision summary

Use one single-column dropdown with two views: the existing workflow list and
a per-lineage run panel reached by drilling in. The header's run identity
badge is a third split-button segment that opens the run panel for the viewed
lineage directly, keeping same-workflow run switching at two clicks; the
chevron keeps the workflow list at two clicks; back returns from runs to
workflows with scroll and filters intact. Both views are plain flat
virtualized lists, so 1,000-run lineages need only ordinary virtualization
plus `scrollToIndex` — no sticky parents, mixed-kind row models, tree
semantics, or collapse anchoring. Run navigation UI is progressive: the badge
and row indicators appear only when a lineage has more than one addressable
target, so single-run workflows — and users who never re-run — keep exactly
today's header and dropdown. Workflow and run identities stay stable
(`workflowKey`/`runRef`/manifest `runId`) end to end.
