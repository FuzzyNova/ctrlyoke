# Workflow Step Panel Improvements Plan

**Status:** Not started (planned 2026-11-09).

Three related improvements to the steps panel (`WorkflowStepsPanel` + `FinalStepFooter`):

1. **Retry and pass rows**: every attempt of a step, and every final-step pass, gets its own
   clickable row that scrolls the output pane to that attempt or pass.
2. **Final-step click navigation fix**: clicking the Final Step row must scroll the output pane
   to the most recent final-step pass, the same way clicking a queue step does.
3. **Virtualize the step list**: resizing or expanding the panel with ~50+ steps is slow. Move
   the list onto the shared TanStack foundation that the other long lists already use.

They are grouped because (1) changes row heights and adds nested scrollers, and that has to be
designed with (3) in mind. Navigation for (1) and (2) goes through one new code path.

---

## Problems today

| #   | Problem                                                                                                                                                                                                                                                                    | Where                                                                                                                             |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| P1  | `Retry N of M` shows only while the step runs. `retryStates` is transient: it is keyed by queue step index only, set by `RETRY_ATTEMPT_CHANGED`, and cleared afterwards. A completed step does not show that it retried. The final step never shows retries.               | `PromptStepDetails.tsx:126`, `workflowStore.ts` `setRetryState`/`clearRetryState`, `useMessageHandler.ts` `RETRY_ATTEMPT_CHANGED` |
| P2  | Clicking a step scrolls to the target's anchor row (`scrollToTarget` → `anchorRowIndexByTarget`), which is the step's first output. There is no way to land on "Retry 2".                                                                                                  | `useStepClickHandler.ts`, `useOutputNavigation.ts` `scrollToTarget`                                                               |
| P3  | In the output pane, attempt groups with more than one attempt start **collapsed** (`collapsedAttemptGroupKeys`, local `useState` in `useOutputRowsModel`). So the row for retry 2 often does not exist until the user expands the group.                                   | `useOutputRowsModel.ts:187-213`, `outputRows.ts` `getCollapsibleAttemptGroupKeys`                                                 |
| P4  | Clicking the Final Step row only calls `selectFinalStep`. It never navigates the output. The same handler is duplicated in `WorkflowStepsPanel.handleFinalStepSelect` and `PromptChipRail.handleFinalStepClick`.                                                           | `WorkflowStepsPanel.tsx:1027`, `PromptChipRail.tsx:694`                                                                           |
| P5  | Across multiple passes, there is no way to jump to "pass 2". The output already addresses each pass as its own target (`{ kind: FINAL_STEP, index: loopIndex }`), so only the UI is missing.                                                                               | `outputProjection.ts` `toOutputMessageTarget`                                                                                     |
| P6  | Every step row is mounted: done steps, pending sortable steps, and groups. Each row also has its own store subscriptions (`useSettingsStore` in `WorkflowStep`, `useIsStepInOutputView`, and so on). Mounting the panel and every resize frame both scale with step count. | `WorkflowStepsPanel.tsx:1973-2200`                                                                                                |

---

## Part 1: Attempt and pass data (single source)

### Attempt index selector

Add `useStepAttemptIndex()` next to `useLatestStepOutput` in `hooks/useLatestStepOutput.ts`.
That file already owns "the displayed output history, history-aware" and the
"prompt/script phase only" filter. The selector derives everything in one memoized pass over
`useDisplayedOrderedEntries()`:

```ts
interface StepAttemptSummary {
  target: OutputMessageTarget; // QUEUE{index} or FINAL_STEP{loopIndex}
  runIndex: number; // manual re-run (0 = original run)
  attemptIndex: number; // retry within that run (0 = initial attempt)
  isStreaming: boolean;
  durationSeconds?: number; // from the CliOutput, same source PromptStepDetails uses
  tokenTotalLabel?: string; // formatTokenCount(resolveTokenTotal(...))
  status?: StepStatus; // terminal outcome of this attempt, if known
}

/** keyed by getTargetKey(target); attempts in chronological order */
type StepAttemptIndex = ReadonlyMap<string, readonly StepAttemptSummary[]>;
```

- Use the same filter as `useLatestQueuePromptEntries`: `OUTPUT_HISTORY_KINDS.CLI` plus
  `isPromptExecutionPhase(entry.phase)`. Condition-script entries share the step's
  `stepIndex`, but they are not attempts. Attempt identity is `(runIndex, attemptIndex)`,
  matching `getAttemptRowKeyBase` in `outputRows.ts`.
- This index is the **durable** retry count. It works after completion and when browsing
  history, which fixes P1 without persisting anything new. `retryStates` remains the live
  "Retry N **of M**" denominator only. Nothing else needs `maxRetries`.
- Final-step passes come from the same map: every key with `kind === FINAL_STEP` is one pass.
  The footer no longer has to infer passes from `loopCount` alone. `loopCount + 1` still
  bounds the list, because a pass that is queued but has not started has no output yet.
- Rows subscribe per target with a primitive or stable-reference selector, so streaming
  output for step 7 does not re-render step 3. Keep the map's per-key arrays referentially
  stable when their content is unchanged; `preserveReferences` already exists in
  `workflowStore`.

### Labels

Reuse `formatAttemptLabel` / `formatRunLabel` / `formatExecutionBadge` from `utils/outputUtils.ts`
("Retry 2", "Re-run 1 · Retry 2", "Initial Attempt"), so the panel and the output headers name an
attempt the same way. Build pass labels from `src/utils/FinalStepLabels.ts`
(`formatFinalPassLabel`), as the terminology rule requires. Do not add new string literals.

---

## Part 2: Retry and pass rows (UI)

### Queue steps: the attempts accordion

A step gets an accordion when its attempt list has **2 or more entries** in the displayed
history: at least one retry, or at least one manual re-run.

```
┌──────────────────────────────────────────────┐
│ ▷  💬 Fix the failing tests            ▮ 14%│
│      Copilot CLI · gpt-6-luna               │
│      2:14 · 48.1k tks · a1b2c3 ⧉           │
│    ▾ 4 attempts                              │  ← accordion header (chevron + count)
│    ┌──────────────────────────────────────┐ │
│    │ Initial Attempt   0:31 · 9.8k     ✗   │ │  ← indented attempt rows,
│    │ Retry 1           0:40 · 12.0k    ✗   │ │    max-height ≈ 5 rows,
│    │ Retry 2           0:29 · 11.4k    ✗   │ │    own scrollbar
│    │ Retry 3           0:34 · 14.9k    ✓   │ │
│    └──────────────────────────────────────┘ │
└──────────────────────────────────────────────┘
```

- **New component** `components/prompts/StepAttemptList.tsx`. It is shared by queue rows and
  the final-step footer (see below), keeping one implementation for both, as
  `PromptStepDetails` already does for the metadata rows.
- **Placement**: render it from `WorkflowStepRow`, after the `WorkflowStep` body and inside the
  sortable wrapper, so it moves with a dragged row. Do not put it inside `WorkflowStep`'s own
  `role="button"` container: nested interactive rows inside a pseudo-button cause the mobile
  hover/focus drift described in `webview-react-components.instructions.md`. Use native
  `<button>`s for the header and the attempt rows. `ParallelGroupPanel` renders members through
  `WorkflowStepRow`, so group members get the accordion with no extra work.
- **Height cap**: `max-height` = header + 5 rows (about `5 × 22px`). Use `overflow-y: auto` and
  `overscroll-behavior: contain` so wheel input over the accordion does not scroll the whole
  panel at the end of the list. Above about 50 attempts, render the rows through the shared
  `VirtualizedList` (`components/shared/VirtualizedList.tsx`) with the accordion as its
  `scrollContainerRef`. A step with 1000 retries mounts about 10 rows.
- **Live behaviour**: while a step is running and retrying, the newest attempt is appended
  live. When the user has not scrolled the accordion, keep it pinned to the newest row; when
  they have scrolled up, leave it where they put it. The current `Retry N of M` line in
  `PromptStepDetails` stays during the run, because it is the only place that shows the
  denominator.
- **Expanded state**: store it in `uiStore` (`expandedAttemptTargetKeys: ReadonlySet<string>`),
  not in component state, because virtualization (Part 4) unmounts rows. Default: collapsed,
  except the currently executing step, which auto-expands when its second attempt starts (see
  open question Q1). Keep it session-only; it does not need persisting.
- **Row content**: label, duration, token total, and a small status icon (`StatusIcon`, `size`
  scaled down). Add an `InOutputViewBar` per attempt only if Part 3's attempt-level in-view keys
  land (optional; see Follow-ups).
- **Collapsed summary**: when collapsed, the header itself ("▸ 4 attempts") is the
  after-completion retry indicator from P1. No separate chip is needed.

### Final step: pass rows in the expanded footer

- In `FinalStepFooter`'s expanded details, below `PromptStepDetails`, render
  `StepAttemptList` in **pass mode** when `passCount >= 2`. It has one row per pass, labelled
  `formatFinalPassLabel(n)`, with duration, tokens and status. Use the same max height of about
  5 rows with its own scrollbar, virtualized above the same threshold.
- A pass that itself retried shows its attempts as nested, further-indented rows under the pass
  row, inside the same scroller. They are flattened, not a second accordion, so there is never
  a scroller inside a scroller (open question Q3).
- The existing per-pass in-view logic (`useFinalStepPassesInOutputView`,
  `outputInViewTargetKeys`) already knows which passes are on screen. Each pass row gets the
  `InOutputViewBar` for free.
- Newest pass at the bottom (chronological, matching the output). When a new pass starts and
  the list has not been scrolled up, keep it pinned to the bottom.

### PromptStepDetails cleanup

- Keep the running-only `Retry N of M` row.
- Leave the compact stats row (duration · tokens · session) unchanged. It describes the
  **latest** attempt, which is what `useLatestStepOutput` already returns. State that in the row's
  tooltip ("Latest attempt"), so that once the accordion exists a reader does not take it for a
  sum across attempts.

---

## Part 3: Navigation (P2, P3, P4, P5)

### One click path for all targets

Extend `useStepClickHandler.ts` into a small family that shares one
`navigateOutputTo(target, attempt?)` helper. Callers keep their own selection logic; the
helper handles the deferred `requestAnimationFrame` scroll currently written inline there:

| Click                                              | Selection                                 | Navigation                                                              |
| -------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------- |
| Queue step row                                     | unchanged (`selectPrompt` / multi-select) | `scrollToTarget({QUEUE, index})` (unchanged)                            |
| Attempt row                                        | select the owning step (plain click)      | `scrollToAttempt({QUEUE, index}, {runIndex, attemptIndex})`             |
| Final Step row (collapsed bar or expanded details) | `selectFinalStep` (unchanged)             | `scrollToTarget({FINAL_STEP, latestPassLoopIndex})` (**new**, fixes P4) |
| Pass row                                           | `selectFinalStep`                         | `scrollToTarget({FINAL_STEP, loopIndex})`                               |
| Pass's nested attempt row                          | `selectFinalStep`                         | `scrollToAttempt({FINAL_STEP, loopIndex}, {...})`                       |

- Add `useFinalStepClickHandler()` beside `useStepClickHandler()`, and use it from **both**
  `WorkflowStepsPanel.handleFinalStepSelect` and `PromptChipRail.handleFinalStepClick`. These
  are duplicates today and both have the bug.
- `latestPassLoopIndex` = the `loopIndex` of the newest final-step entry in the attempt index,
  not `finalStepLoopCount`. While pass N+1's queue loop is running, the final step has no
  output for that pass yet, so navigation lands on the newest pass that has output. This uses
  the same reasoning as the `useFinalStepLatestOutput` comment. When no pass has output, do not
  navigate (selection still happens).
- **Navigation is read-only.** Attempt rows and pass rows should navigate even when
  `isExternallyManaged` / `isLineageReadOnly` block selection. Today `handleStepClick` returns
  early in watch mode, so a watched CLI run cannot navigate at all. Split the guard so the
  selection is gated and the scroll is not (open question Q2 for the main step row).

### `scrollToAttempt` on the navigation controller

`OutputNavigationController` (`utils/outputNavigation.ts`) gains:

```ts
scrollToAttempt: (
  target: OutputMessageTarget,
  attempt: { runIndex: number; attemptIndex: number },
  options?: OutputNavigationOptions
) => void;
```

Implementation in `useOutputNavigation` / `useOutputRowsModel` / `buildOutputRows`:

1. **Row map**: `buildOutputRows` records
   `anchorRowIndexByAttempt: Map<string, number>`, keyed by
   `getAttemptRowKeyBase(targetKey, runIndex, attemptIndex, undefined)`. Record the attempt's
   first emitted header row; for multi-activity attempts this is the leading-chrome slice
   (`attemptsWithLeadingChrome`). Record it after any group-header push, as the
   `firstRowIndexByTarget` rule in the components instructions requires. Return it from
   `BuildOutputRowsResult` beside `anchorRowIndexByTarget`.
2. **Collapsed groups (P3)**: if the attempt's group key (`getAttemptGroupKey` ⇒
   `<target>:run<n>`) is in `collapsedAttemptGroupKeys`, the attempt has no rows. The controller:
   - calls a new `expandAttemptGroup(groupKey)` exposed by `useOutputRowsModel`. Collapse state
     stays local to that hook; only the setter is exposed.
   - records a **pending attempt navigation** and resolves it in the layout effect that runs
     once `anchorRowIndexByAttempt` contains the key. Reuse the existing pending-navigation
     stabilization (`schedulePendingNavigationStabilization` / `finalizePendingNavigation`) so
     virtualized measurement settles before the final scroll.
3. **Fix the re-collapse quirk first.** `useOutputRowsModel`'s reseed effect adds back
   **every** collapsible key whenever `collapsibleAttemptGroupKeys` gets a new identity, which
   happens on every message batch. A group the user (or `scrollToAttempt`) expanded therefore
   snaps shut on the next streamed output. Change it to add only keys that are _newly_
   collapsible since the previous set. Without this, attempt navigation during a live run
   undoes itself. File it as its own bug in `dev/bugs/backlog/` if it is fixed separately.
4. **Hidden targets**: when the step is hidden (minimap toggle), land on the `STEP_HIDDEN`
   placeholder, the same way `scrollToTarget` already does.
5. **Fallback**: if the attempt cannot be found (output truncated, or history missing that
   attempt), fall back to `scrollToTarget(target)` so the click still does something sensible.

### Tests (navigation)

- `test/hooks/useStepClickHandler.test.ts`: the final-step handler navigates to the newest
  pass with output, not to `loopCount`, and does not navigate when there is no output.
- `test/hooks/useOutputNavigation.test.ts`: `scrollToAttempt` on a visible attempt, a collapsed
  group (expand → pending → resolve), a hidden target, and the missing-attempt fallback.
- `outputRows` unit tests: `anchorRowIndexByAttempt` for single-activity, multi-activity,
  multi-run and final-step-pass targets, and for a group header preceding the attempt.
- `useOutputRowsModel`: a user-expanded group stays expanded when new messages arrive.

---

## Part 4: Virtualize the step list (P6)

### Measure first

Before building, confirm where resize time goes. Run
`npm run dev:host:profile -- --target dashboard` (see the "Slowness / stalls" section of
`.github/copilot-instructions.md`) with a 100-step workflow while dragging the panel separator.
Two possible culprits:

- **React re-render cost.** Something in the resize path re-renders `WorkflowStepsPanelInner`
  and all its rows (for example a store write from `App.tsx`'s `Panel onResize`, or
  `useElementNarrow` on the header crossing a boundary). Virtualization helps; fixing the
  re-render trigger helps more and costs less.
- **Layout/paint cost** of N flex-wrap rows. Only virtualization (or the stop-gap below)
  helps.

Stop-gap if needed immediately: `content-visibility: auto` with a `contain-intrinsic-size`
estimate on `WorkflowStepRowFrame` cuts the layout cost of off-screen rows without touching
React or dnd-kit. It does not reduce mount cost or subscriptions, so it does not replace
virtualization.

### Model: flatten the panel into one item list

The list currently renders two separate sections (done rows, then the `DndContext` +
`SortableContext` pending rows) plus groups and a tail slot. Flatten them into a single
`StepPanelItem[]` computed in a `useMemo`:

```ts
type StepPanelItem =
  | { kind: "doneStep"; key: string; index: number; estimate: number }
  | {
      kind: "group";
      key: string;
      groupId: string;
      pending: boolean;
      estimate: number;
    }
  | { kind: "pendingStep"; key: string; dragId: string; estimate: number }
  | { kind: "pendingTail"; key: string; estimate: number };
```

Put the kind discriminants in `DashboardConstants.ts` (no string literals in flow control).

- **Order**: done rows, then `previewDragState.order` (live preview order), then the tail slot.
  This is the order the DOM uses today, so the live-preview DOM reorder keeps working.
- **Keys**: pending steps use their drag id (`stepDragId(absoluteIndex)`); done steps keep their
  existing `step-${index}-${name}` key. Mind the components-instructions bullet about drag ids
  encoding position. Read the virtualizer keys from the same `(previewDragState, steps)` pair
  the rows render from, never a mismatched one.
- **Estimates**: precompute an O(1) estimate per item (`VirtualizedList`'s contract). Step body
  ≈ title + harness/model line + optional stats line + optional overrides line + attempt
  accordion height (`header + min(n, 5) × rowH` when expanded). Groups are estimated as header +
  Σ members. `measureElement` corrects the estimate after mount.

### Rendering: flow spacers, not absolutely positioned rows

Use `useVirtualizedListFoundation` (`components/shared/VirtualizedListFoundation.ts`), which
already handles the "parent-owned scroll ref resolves to null on mount" gotcha. Render the
visible slice in normal flow between a top spacer (`virtualItems[0].start`) and a bottom spacer
(`totalSize - last.end`), **not** as `position: absolute` rows with `top`/`translateY` like
`OutputPane` uses. Reasons:

- dnd-kit measures droppables with `getTransformAgnosticClientRect`, which inverts only an
  element's **own** transform. A `translateY` on a virtual wrapper is an ancestor transform that
  shifts every measured rect, the same failure the instructions describe for hoisting row
  displacement onto `WorkflowStepRowFrame`.
- The live preview physically reorders DOM nodes and `useDerivedTransform` FLIPs them.
  Flow layout keeps both working unchanged; absolute positioning would require re-deriving
  every preview position through the virtualizer.
- The `DndContext` / `SortableContext` stay where they are and wrap the whole flattened slice.
  `SortableContext.items` keeps receiving **all** pending ids (`pendingDragItems`, including
  `PENDING_TAIL_DRAG_ID`), mounted or not, as dnd-kit requires.

Threshold: virtualize only at or above ~40 items (`VirtualizedList`'s `threshold` pattern).
Small workflows, and most existing tests, keep rendering every row exactly as today.

### Drag-and-drop under virtualization (main risk)

dnd-kit only collides against **mounted** droppables. The panel's collision and preview loop is
heavily tuned (five instruction bullets on it). Rules:

1. **Pin the dragged item**: extend the foundation's `rangeExtractor`, which already pins
   `focusedIndex`, to also pin the active drag item's index, so the drag source never unmounts
   while it is scrolled out of the range.
2. **Never shrink the range during a drag**: on `onDragStart`, snapshot the current overscan
   range. While `activeDragId` is set, the range may only grow, for example as dnd-kit
   autoscroll reveals more rows. It never unmounts a droppable that `closestCenter` might have
   measured. Return to normal windowing on drop or cancel.
3. **Bump overscan while dragging** (e.g. 5 → 15), so the rows just past the viewport edge
   already exist when autoscroll begins.
4. **Verify in the dev host with the keyboard sensor** (Space, then arrows, then Space), not
   Playwright pointer drags. The components instructions explain why pointer simulation does
   not move dnd-kit's collision position in this panel. Cover: drag from top to bottom across
   an unmounted region, drag into and out of a parallel group at the edge of the range, and
   drag to the first and last slots.
5. The existing model-walking regression tests (`settling over a modelled layout`,
   `WorkflowStepsPanel group drag settling` in `WorkflowStepsPanelDrag.test.tsx` /
   `WorkflowStepsPanel.test.tsx`) are pure and must keep passing unchanged. Add one integration
   test that drags above the threshold with `offsetHeight` stubbed: jsdom reports 0 for it,
   and it is what virtual-core measures (see the `VirtualizedDropdownList` instructions bullet).

If rules 1–3 do not hold up in manual testing, the fallback is to **turn virtualization off
for the pending section during a drag**: mount the full pending list on drag start. That is
slow only for the length of a drag on very long lists, but it is always correct.

### Other things that rely on every row being mounted

- **Keyboard and selection**: Ctrl+A, Delete, Ctrl+C/V and shift/ctrl multi-select all work on
  store indices, not DOM, so they are unaffected. Focus: the foundation's focus retention keeps
  the focused row mounted.
- **Scrolling a step into view**: nothing in the panel currently scrolls a step row into view
  (no `scrollIntoView` on `data-prompt-index`). If "reveal the running step" or "reveal the
  selected step" is wanted later, it must go through `rowVirtualizer.scrollToIndex`, never a
  DOM query.
- **`PauseBoundary`** before the first pending row (`showPauseBoundaryBefore`) stays part of
  that row's item, so it is included in that row's measured height.
- **Lineage read-only overlay** (`pointer-events-none opacity-60`) stays on the scroll
  container. No change.
- **Context menu / long-press**: these are attached per row and to the container background.
  Unaffected.

---

## Phasing

Each phase ships on its own, with tests and a `CHANGELOG.md` **Changed** entry where users
would notice:

1. **Final-step click navigation** (P4): `useFinalStepClickHandler`, used by both the panel and
   the chip rail. Small and independent; ship first.
2. **Re-collapse fix** in `useOutputRowsModel` (prerequisite for attempt navigation).
3. **Attempt index selector + `StepAttemptList`** for queue steps and final-step passes, with
   navigation at target or pass level (pass rows can already use `scrollToTarget`).
4. **`anchorRowIndexByAttempt` + `scrollToAttempt`**, wired to attempt rows.
5. **Profile, then virtualize the step list**, with drag verification in the dev host.

Doing phases 3–4 before 5 means the virtualization estimates are written against the final row
shape (accordion included) rather than revised afterwards.

## Docs

The dashboard UI changes, so update the hand-written docs page covering the steps panel and
final step (find it under `docs/`, likely the dashboard/output guide): attempt rows, pass rows,
click-to-navigate. No schema, settings, or persisted-format changes. Everything is derived from
existing output history.

## Open questions

- **Q1. Default accordion state.** Collapsed for completed steps and auto-expanded for the step
  currently retrying (proposed)? Or always collapsed, with the header count as the only
  indicator?
- **Q2. Watch-mode navigation for the main step row.** Should clicking a step in an externally
  managed (CLI watch) workflow navigate the output even though it cannot select the step?
  Attempt and pass rows will navigate regardless (proposed).
- **Q3. Final-step pass retries.** Flatten them as nested, further-indented rows inside the
  pass list (proposed), or show only a retry count on the pass row?
- **Q4. Manual re-runs.** Count them as accordion rows ("Re-run 1 · Retry 2", via
  `formatExecutionBadge`) as proposed, or limit the accordion to retries of the latest run?

## Follow-ups (out of scope)

- Attempt-level in-view markers: extend `outputInViewTargetKeys` with attempt keys so the
  attempt row currently on screen gets an `InOutputViewBar`.
- Reveal the running step in the steps panel (`scrollToIndex`) when it changes during a long
  run.
- Apply the same attempt rows to the collapsed `PromptChipRail` (e.g. a popover per chip).
