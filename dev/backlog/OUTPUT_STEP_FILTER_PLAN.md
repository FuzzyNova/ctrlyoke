# Output Pane Step Filter / Hide Plan

> **Last Updated:** September 3, 2026
>
> **Status:** Ready to implement. Audited against `main` on this date; every symbol named
> below was verified to exist. The questions the previous revision deferred are decided
> here. **Correction in this revision:** Decision 3 previously keyed the hidden set by
> workflow instance id and claimed existing `loadWorkflow`/`RUN_VIEW_LOADED` transitions
> clear `outputScrollTargets` per address. They do not — `resetUi` is its only reset — so a
> filter would have leaked between runs of the same lineage. The state is now keyed by view
> address, which clears it structurally. This is the recommended precursor to
> [`PARALLEL_STEPS_PLAN.md`](PARALLEL_STEPS_PLAN.md) Stage 5, which reuses the state and
> row-building primitives this plan ships.
>
> **Staging note:** this doc is written to be handed to the Spec-Driven Loop orchestrator as
> its `specFile`. The "Implementation Order" section is the intended queue-step split; each
> step must leave `npm run typecheck`, `npm run lint`, and `npm run test:ui` green and commit
> its own work. Manual verification happens after the whole doc lands, using the
> "Manual Test Script" section.

## Goal

Let users show/hide individual steps in the Output pane for an ordinary sequential
multi-step workflow. Today a long run (8+ steps) renders every step's full output in one
scrolling list with no way to isolate a step or silence a noisy one.

## Why This Is Its Own Doc

`PARALLEL_STEPS_PLAN.md` Stage 5 needs per-step filter chips for interleaved parallel-group
activity. That need is not specific to parallel execution: a sequential workflow already
produces output where a user wants only step 3, or wants step 2's debug noise hidden.

The plumbing for the sequential case already exists, so this does not wait on any parallel
runtime work:

- Every render row is step-attributed. `OutputMessageTarget` (`utils/outputProjection.ts`)
  is `{ kind: FinalStepPhase; index: number }`, `getTargetKey()` gives it a stable string
  key, and every concrete member of the `OutputRenderRow` union in `utils/outputRows.ts`
  declares `target: OutputMessageTarget` as required. (The base interface `OutputRowBase`
  still declares `target?` optional and is not exported; see "Type cleanup" below.)
- `CliHeaderRow` additionally carries `stepIndex`, `stepName`, `stepLabel`, `isFinalStep`,
  `attemptIndex`, and `runIndex`. **`StepAnchorRow` carries only `target`** — the previous
  revision of this doc cited `StepAnchorRow.stepIndex`/`stepName`, which do not exist.
- `OutputSection.tsx` already owns the step minimap (`useOutputMinimapModel`, `MinimapStep`,
  `handleMinimapStepClick`), so there is a per-step affordance to extend rather than a new
  surface to invent. Note the minimap element itself is rendered by
  `output-section/OutputPane.tsx`, which receives `minimapSteps` and `onMinimapStepClick`
  as props — so OutputPane is **not** untouched by this plan (it gains pass-through props),
  but it still learns nothing about filtering.
- `buildOutputRows()` already has a "replace a contiguous run of rows with one summary row"
  path: `collapsedAttemptGroupKeys` (`BuildOutputRowsInput`, `useOutputRowsModel.ts`) skips
  every non-first message of a collapsed retry group and emits one
  `AttemptGroupSummaryRow`. Hiding a step is structurally the same operation and must reuse
  that shape rather than add a second mechanism.

Building this first exercises the filter-state, row-building, and virtualization mechanics
on the single-writer case, so the parallel plan's group filter chips become a second
_control_ over the same state instead of a second _mechanism_.

## Decisions

### 1. Control surfaces: minimap toggle, step context menu, header pill

Three ways to change the same state; no new panel.

- **Minimap entry toggle.** Each `MinimapStep` entry in `components/output/OutputMinimap.tsx`
  gets a hover/focus-revealed eye button that toggles that step's visibility. Hidden entries
  render dimmed. This is the primary desktop affordance.
- **Step row context menu.** `utils/stepContextMenuItems.ts` / `hooks/useStepContextMenu.tsx`
  (and the final-step equivalent in `useFinalStepContextMenu.tsx`) gain three items:
  `Hide output`, `Show output` (whichever applies), and `Show only this step's output`. This
  is the affordance that works on touch/mobile layouts and for keyboard users, and it lets a
  user act on a step from the steps panel without locating it in the minimap.
- **Header pill.** When at least one step is hidden, `output-section/OutputSectionHeader.tsx`
  shows a small pill `N hidden · Show all`. Clicking it clears the filter. This is the
  discoverability/escape hatch so a user never wonders where their output went.

Filter _chips_ (`All · 1 · 2 · 3`) are deliberately **not** built here. They belong to the
parallel-group header in `PARALLEL_STEPS_PLAN.md` Stage 5 and will be a fourth control over
this same state.

### 2. Multi-select hide set with a "solo" shortcut

The state is a _hidden set_, not a single selection. Default is empty (everything visible).

- Toggle adds/removes one target.
- **Solo** = "show only this step": sets the hidden set to every other target currently
  present in the output. Reachable via the context-menu item and via **Alt/Option-click**
  on a minimap entry. Solo-ing an already solo'd step clears the filter (toggle behavior).
- Targets are addressed by `getTargetKey(target)` strings, so final-step loop outputs
  (`finalStep:<loopIndex>`) are hideable exactly like queue steps.

### 3. State lives in `uiStore`, keyed per **view address**, not persisted

`workflowStore` is the zundo-snapshotted document model (every output mutation there is
wrapped in `withUndoPause`); view state does not belong in it. `uiStore` already holds
this shape of transient per-workflow view state twice — `activeOutputTabs` and
`outputScrollTargets`, both `Record<string, …>` (see how `OutputSection.tsx` reads them).
Copy the _record_ shape, but **not their key**.

Those two are keyed by `activeWorkflowId ?? SHELL_WORKFLOW_ID` — a workflow _instance_ id,
which is identical across every run of the same lineage — and neither is ever cleared per
address; `resetUi` is their only reset. A hidden set keyed that way would leak from one run
to another, which is exactly what this feature must not do. Key `hiddenOutputTargets` by
the **view address** instead, so switching runs changes the key and the filter clears
structurally, with no new clear transition to wire or forget.

`store/executionPreviewStore.ts` already has a private `addressKey(address)` doing exactly
this (`<workflowKey>:run:<runRef>` / `<workflowKey>:draft`). Promote it to a shared
`workflowViewAddressKey()` in `utils/viewAddress.ts` — the file that exists specifically so
address logic has one implementation — and switch `executionPreviewStore` to import it
rather than leaving a second copy behind.

```typescript
// uiStore — workflowKey below is a workflowViewAddressKey() string, not an instance id.
hiddenOutputTargets: Record<string, HiddenOutputTargetsEntry>;
interface HiddenOutputTargetsEntry {
  /** getTargetKey() strings. */
  keys: readonly string[];
  /** When each key was hidden; drives the "hidden but active" indicator. */
  hiddenAtMs: Readonly<Record<string, number>>;
}
toggleHiddenOutputTarget(workflowKey, targetKey): void;
soloOutputTarget(workflowKey, targetKey, allPresentTargetKeys): void;
clearHiddenOutputTargets(workflowKey): void;
```

Rules:

- **Not persisted.** Do not add it to `persistedFields` in `uiStore.ts`. A filter is a
  reading-session gesture, and the persisted allowlist is for layout preferences.
- **Cleared when the viewed address changes — structurally, by the key.** A hidden set from
  one run is meaningless on another, and address keying gets that for free: navigating to a
  different run yields a different `workflowViewAddressKey()` and therefore an absent entry.
  Do not add a clear-on-`loadWorkflow`/`RUN_VIEW_LOADED` hook; there is no such per-address
  reset today (`resetUi` is the only thing that empties `outputScrollTargets`), and adding
  one would be a second mechanism for what the key already guarantees. Run _continuation_
  (`promoteHistoryToLive`) keeps the same address, so the filter correctly survives it.
  Read the address from `uiStore.displayedViewAddress`; when it is null (the standalone
  shell), fall back to `SHELL_WORKFLOW_ID` exactly as `OutputSection.tsx` already does.
- **Stale address entries are pruned on write.** Because entries are never cleared by a
  transition, `toggleHiddenOutputTarget`/`soloOutputTarget` must drop every entry whose key
  is not the one being written. Only one address is viewable at a time, so the record holds
  at most one entry and cannot grow across a long navigation session.
- **Stale keys are harmless.** The row builder only consults the set for targets that exist
  in the current message list; a key for a rewound/deleted step simply never matches. The
  reconciliation effect in `useOutputRowsModel` (which already prunes expansion state
  against the current row set) prunes the hidden set the same way so the header pill count
  stays honest.
- **Delete the dead field `selectedOutputStep`** and its `selectOutputStep` action in
  `uiStore.ts`. No component reads it; it was a single-select sketch of this feature and
  this plan supersedes it.

### 4. A hidden step keeps its anchor and shows one placeholder row

Do not omit a hidden step's rows entirely. For each hidden target, `buildOutputRows()`:

1. still emits the synthetic `StepAnchorRow` at the target's first message (so
   `firstRowIndexByTarget` stays populated and minimap position, `scrollToTarget`, and the
   context menu's "which step am I over" heuristic keep working), and
2. emits exactly one new **`OUTPUT_ROW_KINDS.STEP_HIDDEN`** row (`StepHiddenRow`) in place
   of that target's content, with a fixed `estimateSize`, then `continue`s past every other
   message for that target — the same loop shape as the collapsed-attempt-group path.

The placeholder renders `Step 3 · research-db · hidden` plus a `Show` button, and, while
the step is still producing output, a subtle activity indicator (see Decision 7). Clicking
the placeholder body or its button unhides the step.

Why placeholder rather than omission: navigation targets stay valid, the reader keeps a
sense of where the hidden step sits in the run, the "hidden but active" signal has a home
in the list itself, and the row is a natural target for `Show`. Why placeholder rather than
a zero-height row: the virtualizer measures real elements; a 0px row is a measurement
outlier and an accessibility dead end.

### 5. Copy/export respect the filter; the export range field is the override

Both `Copy All` (`buildCopyAllText` in `hooks/useOutputContextMenu.tsx`) and Markdown export
(`hooks/useOutputExport.ts` → `generateMarkdownExport`) operate on `allMessages`, not on
rows, so a row-level filter changes nothing about them today. Decision:

- `Copy All` copies only visible steps when a filter is active. The context-menu label
  becomes `Copy All (N steps hidden)` so the omission is explicit.
- Export pre-fills the existing `ExportOptions.stepRange` (already parsed from the modal's
  range field by `parseRangeNotation`) from the visible set. The field stays editable, so
  the user can widen the range to override the filter without leaving the dialog.
- `Copy Step Output` / `Copy Output` on a single step are unaffected.

### 6. In-pane find respects the filter automatically; step status never sees it

- `useOutputFind` runs `findOutputMatches(rows, …)` over the rendered rows, so a hidden
  step's text is not searchable while hidden. That is the desired reading of "hide", and
  it costs nothing. The find bar's match count therefore reflects visible output only; no
  extra UI is needed.
- `useLatestStepOutput` / `useFinalStepLatestOutput`, `PromptCounter`, `usePromptStatus`,
  and the steps panel all read _entries_ (`liveOrderedEntries` / `historyOutputs`), never
  rows. The constraint "hiding must not affect step status, progress counts, or step
  markers" is therefore satisfied structurally, not by discipline. Add a test that asserts
  it anyway.
- `HistorySearchDrawer.tsx` (cross-run, backend-indexed search) is unrelated and untouched.
  Its result navigation is a pending-navigation handshake through `LOAD_WORKFLOW`; when the
  target step of that navigation is hidden, **unhide it** before scrolling (explicit
  navigation intent wins over a filter). Minimap clicks on a hidden entry, by contrast,
  scroll to the placeholder and do not unhide.

### 7. Live follow and the "hidden but active" indicator

- The sticky-bottom autoscroll latch (`utils/outputAutoscroll.ts`, `useOutputScrollTarget`)
  is unchanged. If the currently running step is hidden, its placeholder is the last
  content row and the latch simply follows it; this is a mild performance win, because a
  hidden streaming step no longer triggers per-chunk row growth or remeasurement.
- A hidden target whose newest entry `timestampMs` is later than `hiddenAtMs[key]` is
  "active while hidden". The minimap entry shows a small dot and the placeholder row shows
  a pulsing `·` next to `hidden`. Computed in `useOutputMinimapModel` from the same entries
  it already scans; no new store field beyond `hiddenAtMs`.

### 8. Virtualization: omission is safe, but a toggle must force a remeasure

The audit made this less risky than the previous revision feared:

- `useOutputVirtualization` uses `@tanstack/react-virtual` with `getItemKey: row.key`, and
  its `measurementCacheRef` is keyed by `row.key` too. Removing rows mid-list does **not**
  invalidate surviving rows' measurements, and un-hiding a step restores its measured
  heights from that cache for free.
- What does _not_ happen automatically: the bulk remeasure/re-anchor effects are
  deliberately not keyed on `rows.length`, and `rowRenderIdentity` (built in
  `OutputSection.tsx` from file name + run ref) does not change on a toggle. So a toggle is a
  large structural change the layout passes will not notice on their own.

Required handling, following the existing global-diff-collapse precedent
(`diffsCollapsed` + `diffResetVersion`, applied in `useOutputRowsModel`'s flush-then-change
ordering via `onDiffViewReset()`):

1. Add an `outputStepFilterVersion` counter bumped on every hidden-set change.
2. Fold it into `rowRenderIdentity` so the existing identity-change path runs
   `performBulkRemeasure()` and re-applies the scroll target.
3. Scroll-target preservation: if the anchor row of the current `OutputScrollTarget` is
   still rendered, keep it; if it belonged to a step that was just hidden, re-anchor to
   that step's placeholder row; if the target is `BOTTOM`, stay at bottom.
4. Never add a second `scrollTop` writer. All correction goes through the anchor lock in
   `useOutputScrollTarget` (see `webview-react-hooks.instructions.md`).

### 9. Type cleanup that this plan pays for

- Export `OutputRowBase` from `utils/outputRows.ts` and make `target` required on it. Every
  concrete row already requires it; consumers such as `useOutputNavigation`'s local
  `interface OutputRow { key; target? }` and the minimap's `row.target?.kind` are
  defensive against a nullability that no longer exists. Remove those null checks as part
  of this change. (`AttemptGroupSummaryRow` and `StatsRow` must be checked individually
  when making the base field required.)
- Add `STEP_HIDDEN` to `OUTPUT_ROW_KINDS` in `src/types/DashboardConstants.ts`; add the
  row's height estimate to `estimateOutputRowHeight` and a bucket to `getRowHeightBucket`
  (a fixed-height row is the easiest possible bucket, but it must exist or the learned
  scale-factor path will treat it as unknown).

## Implementation Order

Each numbered item is one intended queue step for the Spec-Driven Loop. Each must end with
typecheck, lint, `npm run test:ui` green, and a commit.

1. **State + constants.** The shared `workflowViewAddressKey()` extraction into
   `utils/viewAddress.ts` (with `executionPreviewStore.ts` switched over to it), `uiStore`
   fields/actions from Decision 3, removal of `selectedOutputStep`,
   `OUTPUT_ROW_KINDS.STEP_HIDDEN`, `outputStepFilterVersion`.
   Tests: `test/store/uiStore.test.ts` (toggle, solo, solo-again clears, a different
   address sees an empty set, stale-entry pruning, not in persisted partialize) and
   `test/utils/viewAddress.test.ts` for the key helper.
2. **Row building.** `BuildOutputRowsInput.hiddenTargetKeys`, `StepHiddenRow`, the
   skip-and-placeholder loop in `buildOutputRows`, `OutputRowBase` export/required-target
   cleanup, height estimate + bucket. `useOutputRowsModel` reads the set from `uiStore`
   and prunes stale keys in its reconciliation effect. Tests: `test/utils/outputRows.test.ts`
   (anchor retained, exactly one placeholder per hidden target, `firstRowIndexByTarget`
   unchanged for hidden targets, keys of visible rows identical before/after hiding a
   different step so memoization survives).
3. **Rendering + virtualization.** `OutputRow` renders `StepHiddenRow`; `rowRenderIdentity`
   folds in the filter version; scroll-target preservation from Decision 8. Tests:
   `test/hooks/useOutputVirtualization.test.ts` and `useOutputScrollTarget.test.ts` (toggle
   triggers bulk remeasure; anchor re-targets to placeholder; BOTTOM stays BOTTOM).
4. **Minimap + header controls.** `MinimapStep.hidden` / `hasHiddenActivity`, eye toggle,
   alt-click solo, dimmed style, activity dot; OutputPane pass-through props;
   `OutputSectionHeader` pill. There is **no existing test file for `OutputMinimap.tsx` or
   `useOutputMinimapModel`** — create `test/components/output/OutputMinimap.test.tsx` and
   `test/hooks/useOutputMinimapModel.test.ts` in this step (render, toggle, solo,
   accessible names, hidden-active dot).
5. **Step context menus + navigation.** Context-menu items for queue steps and the final
   step; history-search pending navigation unhides its target; minimap click on a hidden
   entry scrolls to the placeholder. Tests: `useStepContextMenu`, `useOutputNavigation`
   tests.
6. **Copy/export + docs.** `Copy All` filtering + label; export `stepRange` pre-fill; then
   the documentation item below. Tests: `test/hooks/useOutputExport.test.ts` and
   `test/hooks/useOutputContextMenu.test.tsx` — **both are new files**; neither hook has a
   test today (the previous revision implied the context-menu one existed).
7. **Docs** (folded into step 6 above; kept here as its own item because it is a distinct
   deliverable). `docs/` has no dashboard page and never mentions the minimap or the Output
   pane today, so do not invent one for this feature. Add one paragraph ("Hiding steps in
   the Output pane") to `docs/guide/concepts.md` under its `## Step` heading, and update
   the Status line of `PARALLEL_STEPS_PLAN.md`'s Stage 5 prerequisite to say this shipped.

## Manual Test Script

Run in the dev host (`npm run dev:host:start`) against a workflow with at least four steps,
one of them a script step, plus a final step.

1. Run the workflow. While step 2 streams, hide step 2 from the minimap. Expect: a
   placeholder row with the activity indicator, the pane stays at bottom, step 2's status
   in the steps panel keeps updating, `PromptCounter` unchanged.
2. Unhide step 2. Expect: its rows return with no scroll jump beyond a single settled
   correction; heights match what they were before.
3. Solo step 3 via Alt-click, then via the context menu on another step. Expect the pill
   count matches, and solo-ing the same step again clears the filter.
4. With step 1 hidden, scroll to the middle of step 4 and toggle step 1 back on. Expect the
   row you were reading stays under the cursor (anchor lock), not a jump.
5. Hide the final step's output after the run completes. Expect
   `finalStep:<loop>` placeholder; `Copy All` label shows the hidden count; export dialog
   range field is pre-filled with the visible steps and can be widened.
6. Open History Search, pick a hit inside a hidden step. Expect that step to unhide and
   the row to be scrolled into view.
7. Switch to another run in the run panel, then back. Expect the filter to be cleared.
8. Narrow the window to the mobile layout. Expect the context-menu path still works and
   the header pill is visible.

## Affected Components

| Component                                                                                            | Role                                                                                              |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `store/uiStore.ts`                                                                                   | Own `hiddenOutputTargets` + actions; delete `selectedOutputStep`; bump filter version             |
| `utils/viewAddress.ts`, `store/executionPreviewStore.ts`                                             | Shared `workflowViewAddressKey()`; drop the store's private duplicate                             |
| `types/DashboardConstants.ts`                                                                        | `OUTPUT_ROW_KINDS.STEP_HIDDEN`                                                                    |
| `utils/outputRows.ts`                                                                                | `StepHiddenRow`, `hiddenTargetKeys` input, skip-and-placeholder loop, base-type cleanup, estimate |
| `hooks/useOutputRowsModel.ts`                                                                        | Read the set, prune stale keys, feed `buildOutputRows`                                            |
| `hooks/useOutputMinimapModel.ts` / `components/output/OutputMinimap.tsx`                             | `hidden`/`hasHiddenActivity`, eye toggle, alt-click solo                                          |
| `components/layout/output-section/OutputPane.tsx`                                                    | Pass-through props to the minimap only; still no filtering knowledge                              |
| `components/layout/output-section/OutputSectionHeader.tsx`                                           | `N hidden · Show all` pill                                                                        |
| `components/layout/OutputSection.tsx`                                                                | Wire store → rows model; fold filter version into `rowRenderIdentity`; scroll-target preservation |
| `components/output/OutputRow.tsx`                                                                    | Render `StepHiddenRow`                                                                            |
| `utils/stepContextMenuItems.ts`, `hooks/useStepContextMenu.tsx`, `hooks/useFinalStepContextMenu.tsx` | Hide / Show / Show only items                                                                     |
| `hooks/useOutputNavigation.ts`, history search navigation                                            | Unhide on explicit navigation                                                                     |
| `hooks/useOutputContextMenu.tsx`, `hooks/useOutputExport.ts`                                         | Filter-aware Copy All and export pre-fill                                                         |
| `hooks/useOutputVirtualization.ts`, `hooks/useOutputScrollTarget.ts`                                 | Remeasure on toggle; anchor preservation                                                          |

## Non-Goals

- Filtering by content/tool type instead of step. `HistorySearchDrawer.tsx` and the in-pane
  find already cover text search.
- Persisting the filter across separate runs or webview reloads.
- Any parallel-group behavior (group headers, step-switch markers, interleaving, chips).
  That stays in `PARALLEL_STEPS_PLAN.md` Stage 5 and builds on this state.
- A "collapse all steps" command. The pill + solo cover the realistic cases.

## Handoff to the Parallel Plan

What `PARALLEL_STEPS_PLAN.md` Stage 5 should reuse unchanged: `hiddenOutputTargets` and its
actions, `StepHiddenRow`, the skip-and-placeholder loop, `outputStepFilterVersion` in
`rowRenderIdentity`, and the minimap `hidden`/activity model. Its group-header chips are
just another writer of the same set; "solo" over a group's members is the existing
`soloOutputTarget` with the group's member keys.
