# Output Pane Step Filter / Hide Plan

> **Status:** Not implemented. Recommended as a precursor to the parallel-group filter chips
> in [`PARALLEL_STEPS_PLAN.md`](PARALLEL_STEPS_PLAN.md#output-design), but independently
> valuable and shippable on its own.

## Goal

Let users show/hide specific steps in the Output pane for an ordinary sequential
multi-step workflow. Today a long run (8+ steps) renders every step's full output in one
scrolling list with no way to isolate or silence a subset of it.

## Why This Is Its Own Doc

`PARALLEL_STEPS_PLAN.md` Stage 5 designs per-step filter chips for interleaved
parallel-group activity ("Selecting a step produces a coherent per-step view from the same
underlying activity data; it is a filter, not a second stored history."). That need is not
specific to parallel execution — a purely sequential workflow already produces output where
a user wants to see only step 3, or hide step 2's noisy debug output while reading the rest.

The plumbing already exists for the sequential case, so this doesn't need to wait on any of
the parallel-steps runtime work:

- Every render row already carries step attribution: `OutputMessageTarget.index` in
  `outputProjection.ts`, `StepAnchorRow.stepIndex`/`stepName` in `outputRows.ts`, and
  `OutputRowBase.target` on every row.
- `OutputSection.tsx` already renders a step minimap (`useOutputMinimapModel`,
  `MinimapStep`, `handleMinimapStepClick`) for jump-to-step navigation, so there is already
  a per-step affordance to extend rather than a new surface to invent.
- `OutputPane.tsx` is already a generic virtualized row renderer with no knowledge of steps
  or writers; this feature, like the parallel one, belongs upstream of it.

Building this first exercises the filter-state and virtualization mechanics on the simpler
single-writer case, so `PARALLEL_STEPS_PLAN.md` Stage 5 can reuse the same filter primitives
for its group-scoped chips instead of building a second mechanism.

## Proposed UX

Add step visibility controls integrated with the existing minimap rail rather than a
separate control surface. Two candidate shapes, to be prototyped before committing:

- Chips per step (`All`, `1`, `2`, `3`, ...) — matches the visual language already sketched
  for parallel-group filtering, so it reads as the same feature once parallel ships.
- Per-step hide/eye toggle directly on each minimap entry.

Recommend multi-select show/hide over a single-select radio filter: a user is as likely to
want "hide step 3, show everything else" as "show only step 2," and a single-select filter
can't express the former without extra clicks. Default state is every step visible.

Hiding a step from the Output pane must not affect step status, progress counts, or minimap
step markers elsewhere in the UI — only which rows render in the scrolling output list.

## Decisions Deferred to Implementation

These need a quick prototype/comparison rather than being pre-decided here:

- Chips vs. minimap-integrated toggles for the control itself.
- Whether a hidden step's rows are omitted entirely or collapse to a zero-height/placeholder
  entry — this affects virtualization measurement and scroll-position stability, and should
  reuse whatever the `PARALLEL_STEPS_PLAN.md` Stage 5 work learns about that tradeoff.
- Whether "solo" (isolate to exactly one step) is a distinct affordance or reachable through
  the same multi-select control (for example, alt/option-click on a chip).
- Whether filter state persists across a webview reload or resets each time a workflow is
  opened.

## Affected Components

| Component | Planned role |
| --- | --- |
| `OutputSection.tsx` | Own the visible-step-set filter state; pass it into row building |
| `useOutputRowsModel.ts` / `outputRows.ts` | Apply the visibility predicate when building rows; decide how `StepAnchorRow` behaves for hidden steps |
| `useOutputMinimapModel.ts` / `OutputMinimap.tsx` | Add the toggle affordance per step entry |
| `workflowStore.ts` or `uiStore.ts` | Hold the per-workflow-session step visibility selection |
| `OutputPane.tsx` | No change — stays a generic renderer of whatever rows it receives |

## Non-Goals

- Filtering by content/tool-type instead of step. `HistorySearchDrawer.tsx` already covers
  text search and is a distinct, unrelated feature.
- Long-term persistence of filter selection across separate workflow runs.
- Any parallel-group-specific behavior (group headers, step-switch markers, interleaving) —
  that stays entirely in `PARALLEL_STEPS_PLAN.md` Stage 5, which should build on top of
  whatever filter state/UI this ships.

## Open Questions

- Does the minimap need a distinct visual state for "hidden but has new activity" so users
  don't lose track of a background step they've silenced?
- Should copy/export output actions respect the active filter, or always operate on the full
  unfiltered output regardless of what's currently hidden?
