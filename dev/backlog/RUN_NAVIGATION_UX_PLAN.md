# Run Navigation and Run-Number Display

Status: **Proposed**

## Goal

Make the selected run part of the workflow's visible identity and move run
navigation out of the Output panel.

The workflow dropdown should present a lineage and its runs as one hierarchy
that works equally well on desktop and mobile:

1. The header always identifies the viewed workflow and viewed run (or draft).
2. The currently viewed lineage is expanded when the dropdown opens.
3. Other lineages remain one compact row until explicitly expanded.
4. Expanding a lineage with 1,000 runs mounts only the visible run rows.
5. While scrolling those runs, the parent workflow row stays pinned and can
   always collapse the section.
6. Run labels use the manifest's monotonic `runId`; deletion gaps remain visible.
7. Navigation and mutations target stable `{ workflowKey, runRef }` addresses,
   never a list index or inferred “latest” run.
8. The Terminal tab continues to describe execution-owned terminals honestly;
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

## Decision: one virtualized accordion

`WorkflowStatus` keeps its existing single-column dropdown. A workflow row can
expand its run children in place:

```text
[ Workflow8              Run 12    COMPLETED | ▾ ]
[ Workflows  [search workflows] [filters]    [x] ]
| Workflow2              Run 10 ▾  COMPLETED     |
| Workflow3                        COMPLETED     |
| Workflow4               Run 2 ▾       IDLE     |
| Workflow8              Run 12 ▴  COMPLETED     |
|   └                    Run 11    COMPLETED     |
|   └                    Run 10    COMPLETED     |
|   └                    Run  9    COMPLETED     |
|   └                    Run  8    COMPLETED     |
|   └                    Run  7    COMPLETED     |
|   └                    Run  6    COMPLETED     |
|   └                    Run  5    COMPLETED     |
|   └                    Run  4    COMPLETED     |
|   └                    Run  3    COMPLETED     |
|   └                    Run  2    COMPLETED     |
|   └                    Run  1    COMPLETED     |
| Workflow6                        COMPLETED     |
| Workflow7                        COMPLETED     |
```

The accordion has at most one expanded lineage:

- opening the dropdown expands the displayed lineage;
- expanding another lineage collapses the previous one;
- the user may explicitly collapse the expanded lineage, leaving all collapsed
  for the rest of that open session; and
- closing and reopening resets expansion to the displayed lineage.

This bounds the logical list to `workflow count + one lineage's run count`.
There are never 1,000 run children beneath multiple workflow rows at once.

## Header identity

Keep the existing `WorkflowStatus` split-button shape:

```text
┌──────────────────────────────────────────┬────┐
│ Workflow name · Run 1042 · COMPLETED     │  ▾ │
└──────────────────────────────────────────┴────┘
             rename action                  open
```

- The main segment retains its current rename behavior.
- The chevron opens the workflow/run accordion.
- The viewed run identity is a non-interactive badge inside the main segment.
- On narrow layouts, `Run 1042` becomes `#1042`; its accessible label and
  tooltip remain “Run 1042.”
- A draft displays `Draft` instead of a run number.
- The identity remains visible even when the lineage has only one run. There is
  no standalone run selector to show or hide.

Resolve the badge by matching `displayedViewAddress.runRef` against
`runSummaries` and render the matching manifest `runId`. Never derive the
number from array length or index.

## Workflow parent rows

A workflow parent row represents a lineage and one default address:

- for a recent lineage, its advertised address is the latest run or draft
  supplied by the backend;
- for a running lineage, its primary address is its exact execution run; and
- clicking the parent's primary button selects that address and closes the
  dropdown, preserving today's two-click workflow switch.

The row's run label describes that primary address:

- `Run N` for a promoted run, using the latest/default `RunSummary.runId`;
- `Draft` for a draft; or
- no run label for a lineage with no addressable definition.

The disclosure button is a sibling native button, not part of the primary
workflow button. It expands/collapses without selecting or loading the
workflow. Show it only when the lineage has at least one selectable run address
not already represented by the parent:

- a latest-run parent needs `runCount > 1`; and
- a draft parent needs `runCount > 0`.

This preserves the requirement to hide useless run selection for a one-run
lineage while keeping its `Run N` identity visible.

The expanded parent is visually distinct from:

- the displayed lineage;
- the exact selected run;
- a running lineage; and
- a pending run-view target.

These states may overlap and must not be collapsed into one `isSelected` flag.

## Run child rows

Expanded children are the lineage's `RunSummary[]` in newest-first order,
excluding the run already represented by the parent row. A draft parent does
not represent a run, so all promoted runs appear as children.

Each child uses manifest values directly:

```text
└  Run 1042   CODEX   COMPLETED   4 steps      5 minutes ago
```

Recommended cells:

- tree connector/indent;
- selected/live indicator;
- `Run ${summary.runId}`;
- primary harness/model, with the existing mixed-harness/mixed-model treatment;
- execution-state badge;
- step count; and
- relative start/completion time.

Narrow layouts retain the hierarchy but progressively reduce metadata:

```text
└  #1042   ✓
```

The full run number, state, harness/model, steps, and time remain in the row's
accessible name and tooltip.

The child primary button loads this exact address:

```ts
{
  workflowKey: summary.workflowKey,
  kind: "run",
  runRef: summary.runRef,
}
```

The delete action is a sibling native button, targets `summary.runRef`, and is
unavailable for the executing or otherwise protected run.

### Viewing an older run

The parent continues to represent the lineage's default/latest address. If the
client is viewing an older run:

- the parent is marked as the displayed lineage but not as the exact selected
  address;
- the matching child is the exact selected row;
- opening the dropdown expands the lineage and scrolls that child into view;
  and
- the parent immediately becomes sticky if scrolling the selected child above
  the fold requires it.

Do not replace the parent label with the historical selected run. Keeping the
parent as the latest/default shortcut preserves newest-first ordering and avoids
removing an arbitrary run from the middle of the child list.

## One flattened virtual row model

Do not render a nested run list inside a workflow row. Build one flattened row
array for the dropdown:

```ts
type WorkflowNavigationRow =
  | {
      kind: "workflow";
      workflowKey: WorkflowKey;
      // Parent-row display and primary-address data.
    }
  | {
      kind: "run";
      workflowKey: WorkflowKey;
      runRef: RunRef;
      summary: RunSummary;
    }
  | {
      kind: "runs-loading" | "runs-empty" | "runs-error";
      workflowKey: WorkflowKey;
    };
```

For every workflow, append its parent row. Append run/loading/empty/error
children only for `expandedWorkflowKey`. Feed that single array into one
virtualizer.

Keys are stable identities:

- workflow row: `workflow:${workflowKey}`;
- run row: `run:${workflowKey}:${runRef}`; and
- state row: `${kind}:${workflowKey}`.

Never key by flattened index. Expanding/collapsing or receiving summaries
changes indices immediately.

The existing `VirtualizedDropdownList` may be extended if the sticky-row and
scroll-anchor features remain generally useful. Otherwise create a focused
`VirtualizedWorkflowRunList` over the same `@tanstack/react-virtual` primitive
rather than complicating every shared dropdown.

## Sticky expanded parent

When the expanded parent's natural row scrolls above the list viewport and one
of its children is still visible, pin that same keyed parent immediately below
the fixed workflow search/filter header:

```text
[ Workflow8              Run 1209    COMPLETED | ▾ ]
[ Workflows  [search workflows] [filters]      [x] ]
| Workflow8              Run 1209 ▴  COMPLETED     |  sticky
|   └                    Run 110     COMPLETED     |
|   └                    Run 109     COMPLETED     |
|   └                    Run 108     COMPLETED     |
|   └                    Run 107     COMPLETED     |
|   └                    Run 106     COMPLETED     |
|   └                    Run 105     COMPLETED     |
|   └                    Run 104     COMPLETED     |
|   └                    Run 103     COMPLETED     |
|   └                    Run 102     COMPLETED     |
```

Prefer the virtualizer's sticky-range pattern:

- include the active parent index in the virtual range while its child range is
  active;
- render that virtual item as `position: sticky` with the correct background,
  border, and z-index;
- render it in normal flow/absolute positioning before it reaches the sticky
  boundary; and
- release it when the final child leaves and the next workflow parent reaches
  the boundary.

This keeps one semantic/focusable instance of the parent instead of rendering
an interactive visual clone. If a clone is unavoidable, it must be
`aria-hidden`, non-focusable, and delegate its collapse action to the canonical
row; the preferred design avoids this duplication.

### Collapsing while scrolled deep

Collapsing 1,000 children can shrink the virtual content by tens of thousands of
pixels. If state is changed without anchoring, the browser may clamp the old
scroll offset near the end of the shorter list and appear to jump to an
unrelated workflow.

The collapse operation must:

1. capture the expanded parent's stable key/index;
2. anchor or scroll that parent to the top of the list viewport;
3. remove its child rows; and
4. restore focus to the now-collapsed parent disclosure button.

Cover this with a deep-scroll test, not only a top-of-list collapse test.

## Expansion and summary loading

The displayed lineage already has `RUN_VIEW_LOADED.runSummaries`, so its
default expansion requires no backend round trip.

Expanding another lineage requires a request-correlated, summary-only message.
Unlike hover preview, this request occurs only after an explicit disclosure
action, so there is no hover flooding or debounce requirement.

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
remain summary-only. It does not register a new client view, switch an instance,
load a working file, read `events.jsonl`, alter the browser route, or rebaseline
editor/output state.

Cache successful summaries by `workflowKey` plus known
`lastModifiedAt`/descriptor revision for the lifetime of the webview. Invalidate
when newer lineage metadata arrives. Deduplicate repeated expansion while a
request is in flight and correlate responses so a late result populates only
its keyed cache.

When expansion begins:

- collapse the previous lineage;
- expand the requested parent immediately;
- render a virtualized loading child;
- replace it with run children or a clear empty/error child; and
- keep focus on the disclosure unless the user moves it.

## Recent-workflow summary metadata

Collapsed rows need enough manifest metadata to show the correct run number and
whether disclosure is useful without loading all summaries.

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

The existing search and filters continue to target workflow parent rows. Run
children appear only beneath an expanded workflow that survives the current
workflow filter.

- If filtering hides the expanded workflow, remove its children from the flat
  row model but retain `expandedWorkflowKey` for the current open session.
- If it becomes visible again, restore its expansion from cached summaries.
- Search/filter changes must recompute the active sticky parent index from
  stable keys.
- Clearing filters does not reorder runs; summaries remain newest first.

Scrolling is the required first-delivery navigation for a lineage with 1,000
runs. Exact run-ID search or type-to-jump may be added later, but must filter or
navigate the cached `RunSummary[]` by `runId` while still selecting by `runRef`.

## Previous and next navigation

Preserve previous/newer and next/older run navigation without spending
permanent header width:

- expose newer/older actions on the expanded/sticky workflow parent;
- support Arrow Up/Down, Page Up/Down, Home, and End across the flattened list;
- disable the appropriate direction at either end; and
- resolve an adjacent summary to its stable `runRef` immediately before sending
  `LOAD_RUN_VIEW`.

Deleting a run may change array positions, but it must not change displayed
numbers or leave a callback holding a stale index.

## Scaling to 1,000+ runs

### Rendering

At 1,000 summaries, keep the lightweight summary array in memory but mount only
visible rows plus overscan. Definitions and `events.jsonl` are not loaded until
a run is selected.

Add these virtualizer capabilities:

- selected-row `scrollToIndex`;
- active-sticky-parent range inclusion;
- keyboard-active row support without mounting all off-screen rows;
- measured workflow/run row heights; and
- stable-key scroll anchoring across expand/collapse.

The workflow search/filter header remains outside the scroll container. Only
the flattened workflow/run rows scroll.

### Payload and storage measurement

Keep complete summary arrays for the first delivery and measure with 1,000- and
10,000-run fixtures. A thousand small manifest-only records is an acceptable
initial target; the likely costs are manifest scanning and serialization, not
React row count after virtualization.

Targets:

- opening with displayed-lineage summaries already cached becomes interactive
  within 100 ms;
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

When the terminal's execution address differs from `displayedViewAddress`, show
the execution identity in the terminal context:

```text
Terminal · Live Run 1042
```

`WorkflowStatus` continues to show the viewed identity, for example `Run 1031`.
The two labels make the split explicit.

## Component and state changes

### `WorkflowStatus.tsx`

- Read `runSummaries`, `displayedViewAddress`, `executionRunRef`, and pending
  run-view state from `uiStore`.
- Resolve and render the actual manifest `runId`.
- Own ephemeral `expandedWorkflowKey`, initialized from the displayed lineage
  on each open.
- Compose running and recent workflow data into one lineage-level navigation
  model without duplicating a lineage in both sections.
- Keep request correlation and loading feedback through
  `requestRunViewLoad`; do not create another run-selection path.
- Retain the responsive single-mount behavior in `Header.tsx`.

### Workflow/run navigation components

Replace the trigger-oriented legacy `RunSelector` with focused pieces:

- `RunIdentityBadge` — non-interactive header identity;
- `WorkflowRunAccordion` — flattened row construction, expansion, focus, and
  sticky-parent coordination;
- `WorkflowNavigationRow` — parent presentation and sibling disclosure/actions;
- `RunSummaryRow` — child presentation keyed by `runRef`; and
- `useRunSummaryCache` (or equivalent non-persisted store) — summary-only
  loading, request correlation, deduplication, and invalidation.

Extract shared harness, state, count, and time cells/helpers where
`RecentWorkflows` and run rows genuinely share semantics.

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

`runSummaries` and `displayedViewAddress` remain the displayed lineage's sources
of truth. After all callers migrate, remove legacy derived fields if unused:

- `availableRuns`;
- `viewingRunIndex`;
- `runTimestamps`; and
- `runStates`.

If another consumer needs a position, derive it from `runRef` at presentation
time. Never persist or send the position across the webview boundary.

Expanded key, keyboard-active row, and per-lineage scroll positions for the
current open session are ephemeral. The summary cache is non-persisted and
keyed by lineage identity/revision; it is not dashboard selection state.

## Accessibility and responsive behavior

- Parent workflow primary actions, disclosure buttons, and secondary actions
  are sibling native buttons.
- Disclosure uses `aria-expanded` and `aria-controls` for the logical child
  group.
- Run children expose their tree level/relationship using an accessible tree or
  grouped-list pattern selected during implementation; do not rely on the
  visual `└` connector alone.
- The sticky parent remains the same semantic row, so focus and expanded state
  are not duplicated.
- Opening focuses or scrolls to the exact selected address.
- Arrow keys traverse the flattened visible rows; Left collapses an expanded
  parent or returns from a child to its parent, and Right expands a parent.
- Escape closes the dropdown and restores focus to the header trigger.
- High-contrast selection/hover uses `fp-dropdown-row` and
  `fp-dropdown-row-selected`.

The dropdown remains single-column and full-width/bottom-bounded on mobile.
Run children use compact indentation and chip-style metadata, so no alternate
mobile navigation model is necessary.

## Deletion and live-run behavior

- Delete by `{ workflowKey, runRef }`, never a flattened or summary index.
- Keep inline confirmation inside the run child using sibling native buttons.
- An executing run shows its live indicator and cannot be deleted.
- If the parent-represented latest run is deleted, refresh the parent address,
  `primaryRunId`, count, and children from the authoritative response.
- If the viewed run is deleted by this or another client, retain the existing
  deterministic fallback (draft, newest remaining run, or unload lineage).
- If a new run appears while expanded, merge/replace summaries by `runRef`.
  Do not move keyboard focus merely because a newer row was inserted.
- A pending `LOAD_RUN_VIEW` highlights its target separately from the currently
  displayed address and ignores stale responses through the existing request
  ID.

## Test and acceptance matrix

### Identity and correctness

- Runs with IDs `[1042, 1040, 7]` display those exact numbers after deletion;
  no UI substitutes `3`, `2`, or `1`.
- Parent rows display their actual latest/default `runId`; historical selected
  children retain their exact highlight.
- Selecting, deleting, and adjacent-navigating a child sends its exact
  `runRef`.
- Draft, single-run, multiple-run, executing-run, historical-run, and pending
  run-view states render the correct identity and affordance.
- Switching runs preserves coherent definition/settings/output snapshots and
  existing stale-response protection.

### Accordion interaction

- Opening expands the displayed lineage and collapses all others.
- Expanding another lineage collapses the prior lineage and performs at most one
  summary request.
- Clicking a workflow primary action still switches it directly rather than
  toggling expansion.
- A one-run lineage has no disclosure; its run identity remains readable.
- A draft with historical runs can expand those runs.
- Closing and reopening resets expansion to the newly displayed lineage.

### Scale and sticky behavior

- A 1,000-run fixture mounts only visible rows plus overscan.
- Opening on a selected run near the beginning, middle, or end scrolls it into
  view.
- While any child is in the scrolling range, its parent remains sticky below
  the search/filter header and its collapse button works.
- The sticky parent yields when the final child leaves and the next workflow
  reaches it.
- Collapsing after scrolling hundreds of children anchors to the parent instead
  of jumping to an unrelated workflow or blank space.
- Expanding/collapsing and search/filter changes retain stable keys and do not
  leak observers, listeners, or virtualizer measurements.

### Terminal clarity

- Viewing historical Run 1031 while terminals belong to live Run 1042 shows
  both identities in their respective contexts.
- Switching the viewed run does not relabel or rebind the active terminal as if
  it belonged to the historical run.

### Responsive/accessibility

- Narrow layouts render `#1042`, compact child rows, and one
  `WorkflowStatus` instance.
- Mouse, keyboard, and touch can expand/collapse and select exact runs without
  hover-only behavior.
- Keyboard users can reach a virtualized off-screen selected child, return to
  its sticky parent, collapse it, and close with Escape.
- Screen readers distinguish parent workflow rows, expanded state, child runs,
  exact selection, pending selection, and live execution.

## Delivery sequence

1. Add the lightweight parent-row run metadata and summary-only request pair,
   with repository/router isolation tests.
2. Add `RunSummaryRow` and the flattened virtual row model, including
   selected-row scrolling and 1,000-run coverage.
3. Implement one-expanded-lineage state, lazy summary loading, and exact stable
   address selection in `WorkflowStatus`.
4. Implement sticky-parent range behavior and deep-scroll collapse anchoring,
   then cover mouse, keyboard, and touch interaction.
5. Add the header run identity and compact responsive child presentation.
6. Remove the legacy selector from `OutputSectionHeader`/`OutputSection`, delete
   its count/index props and popup-height plumbing, and remove obsolete store
   fields after a caller audit.
7. Add terminal execution-run labeling when viewed and executing addresses
   differ.
8. Run compile, typecheck, lint, formatting, and the full webview/extension test
   suites; manually exercise 1, 2, 1,000, and gapped run IDs across responsive
   tiers.
9. Measure manifest-summary generation and payload/application with 1,000 and
   10,000 runs. Add cursor pagination only if the targets above fail.

## Decision summary

Use one single-column, flattened, virtualized accordion. The displayed lineage
expands automatically; expanding another lineage collapses it. With 1,000
runs, only visible children mount, and the expanded workflow parent stays
sticky so the user can always collapse the section before continuing through
the workflow list. This avoids long cross-column pointer movement, hover
flooding, nested dropdowns, and a separate mobile navigation model while
keeping workflow and run identities in one coherent hierarchy.
