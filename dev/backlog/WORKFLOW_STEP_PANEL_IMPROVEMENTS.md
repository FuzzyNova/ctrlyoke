# Workflow Step Panel Improvements Plan

**Status:** Not started (planned 2026-11-09; design decisions settled 2026-11-09, see
[Decisions](#decisions)).

Four related improvements to the steps panel (`WorkflowStepsPanel` + `FinalStepFooter`):

1. **Retry and pass rows**: every attempt of a step's current run, and every final-step pass,
   gets its own clickable row that scrolls the output pane to that attempt or pass.
2. **Final-step click navigation fix**: clicking the Final Step row must scroll the output pane
   to the most recent final-step pass, the same way clicking a queue step does.
3. **Navigation works in read-only workflows**: CLI-owned runs, runs owned by another VS Code
   window, the commit-message workflow, deleted workflows and history views can all be
   navigated, even though they cannot be edited.
4. **Virtualize the step list**: resizing or expanding the panel with ~50+ steps is slow. Move
   the list onto the shared TanStack foundation that the other long lists already use.
5. **Steps panel follows the output pane**: while the user scrolls the output, the steps panel
   scrolls itself to keep the step being read in view. A manual scroll of the panel turns this
   off until the step being read is back in view. See
   [Part 5](#part-5-steps-panel-follows-the-output-pane).

Optional (recommended): **final-step pass divider rows** in the main list. See
[Part 2b](#part-2b-final-step-pass-dividers-in-the-main-list).

They are grouped because (1) changes row heights and adds nested scrollers, and that has to be
designed with (3) in mind. Navigation for (1) and (2) goes through one new code path.

---

## Problems today

| #   | Problem                                                                                                                                                                                                                                                                                                                                          | Where                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | `Retry N of M` shows only while the step runs. `retryStates` is transient: it is keyed by queue step index only, set by `RETRY_ATTEMPT_CHANGED`, and cleared afterwards. A completed step does not show that it retried. The final step never shows retries.                                                                                     | `StepDetailRows.tsx:126`, `workflowStore.ts` `setRetryState`/`clearRetryState`, `messaging/inboundMessageRouter.ts` `RETRY_ATTEMPT_CHANGED` |
| P2  | Clicking a step scrolls to the target's anchor row (`scrollToTarget` → `anchorRowIndexByTarget`), which is the step's first output. There is no way to land on "Retry 2".                                                                                                                                                                        | `useStepClickHandler.ts`, `useOutputNavigation.ts` `scrollToTarget`                                                                         |
| P3  | In the output pane, attempt groups with more than one attempt start **collapsed** (`collapsedAttemptGroupKeys`, local `useState` in `useOutputRowsModel`). So the row for retry 2 often does not exist until the user expands the group.                                                                                                         | `useOutputRowsModel.ts:187-213`, `outputRows.ts` `getCollapsibleAttemptGroupKeys`                                                           |
| P4  | Clicking the Final Step row only calls `selectFinalStep`. It never navigates the output. The same handler is duplicated in `WorkflowStepsPanel.handleFinalStepSelect` and `StepChipRail.handleFinalStepClick`.                                                                                                                                   | `WorkflowStepsPanel.tsx:1027`, `StepChipRail.tsx:694`                                                                                       |
| P5  | Across multiple passes, there is no way to jump to "pass 2". The output already addresses each pass as its own target (`{ kind: FINAL_STEP, index: loopIndex }`), so only the UI is missing.                                                                                                                                                     | `outputProjection.ts` `toOutputMessageTarget`                                                                                               |
| P6  | Every step row is mounted: done steps, pending sortable steps, and groups. Each row also has its own store subscriptions (`useSettingsStore` in `WorkflowStepItem`, `useIsStepInOutputView`, and so on). Mounting the panel and every resize frame both scale with step count.                                                                   | `WorkflowStepsPanel.tsx:1973-2200`                                                                                                          |
| P7  | Read-only workflows cannot navigate. `handleStepClick` returns early when `isExternallyManaged`; the step list container gets `pointer-events-none` when `isLineageReadOnly` (deleted or system-generated), which blocks every click; the footer's `isSelectionReadOnly` blocks `onSelect`. Navigation and editing share one guard.              | `WorkflowStepsPanel.tsx:1021`, `:1861`, `FinalStepFooter.tsx` `isSelectionReadOnly`                                                         |
| P8  | After a manual re-run (set start position → edit → continue), clicking the step lands on its **first** output ever (`anchorRowIndexByTarget` is set once, at the target's first row), which is the superseded run, not the run the step row now describes.                                                                                       | `outputRows.ts:2535`                                                                                                                        |
| P9  | The steps panel never scrolls on its own. As the user scrolls the output, the in-view marker (bright number + rail bar) moves to steps that are off screen in the panel, so a fast scroll from step 20 into 21 or 22 shows no visible change in the panel. The panel has no "reveal step" path at all (no `scrollIntoView`, no `scrollToIndex`). | `useOutputViewportSteps.ts` → `uiStore.outputInViewTargetKeys`, `InOutputViewMarker.tsx`                                                    |

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
  durationSeconds?: number; // from the CliOutput, same source StepDetailRows uses
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
- **Only the latest run counts.** A manual re-run is a step modification, not an attempt (see
  [Decisions](#decisions)). Rewinding with set start position lets the user change harness,
  model, permissions and prompt before continuing, and the `ContinuationBanner` in
  `HeaderStatusBanner.tsx` already treats continuing as crossing an undo boundary. The step row
  describes the new version, so the attempt list covers only the target's highest `runIndex`.
  Earlier runs stay in the output pane, which keeps all output history, but they get no rows in
  the panel. The selector exposes `latestRunIndex` per target so navigation (Part 3) can land on
  the current run.
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

Reuse `formatAttemptLabel(attemptIndex, true)` from `utils/outputUtils.ts` ("Initial Attempt",
"Retry 2"), so the panel and the output headers name an attempt the same way. The panel never
shows "Re-run N", because earlier runs are not listed. Build pass labels from `src/utils/FinalStepLabels.ts`
(`formatFinalPassLabel`), as the terminology rule requires. Do not add new string literals.

---

## Part 2: Retry and pass rows (UI)

### Queue steps: the attempts accordion

A step gets an accordion when its **latest run** has **2 or more attempts** in the displayed
history, which means at least one retry. A step whose only history is an earlier run plus one
clean re-run gets no accordion.

```
┌──────────────────────────────────────────────┐
│ ▷  💬 Fix the failing tests            ▮ 14%│
│      Copilot CLI · gpt-6-luna               │
│      2:14 · 48.1k tks · a1b2c3 ⧉           │
│    ▾ Retry 3 ✓ · 4 attempts                  │  ← accordion header: latest attempt + count
│    ┌──────────────────────────────────────┐ │
│    │ Initial Attempt   0:31 · 9.8k     ✗   │ │  ← indented attempt rows,
│    │ Retry 1           0:40 · 12.0k    ✗   │ │    max-height ≈ 5 rows,
│    │ Retry 2           0:29 · 11.4k    ✗   │ │    own scrollbar
│    │ Retry 3           0:34 · 14.9k    ✓   │ │
│    └──────────────────────────────────────┘ │
└──────────────────────────────────────────────┘
```

- **New component** `components/steps/StepAttemptList.tsx`. It is shared by queue rows and
  the final-step footer (see below), keeping one implementation for both, as
  `StepDetailRows` already does for the metadata rows.
- **Placement**: render it from `WorkflowStepRow`, after the `WorkflowStepItem` body and inside the
  sortable wrapper, so it moves with a dragged row. Do not put it inside `WorkflowStepItem`'s own
  `role="button"` container: nested interactive rows inside a pseudo-button cause the mobile
  hover/focus drift described in `webview-react-components.instructions.md`. Use native
  `<button>`s for the header and the attempt rows. `ParallelGroupPanel` renders members through
  `WorkflowStepRow`, so group members get the accordion with no extra work.
- **Height cap**: `max-height` = header + 5 rows (about `5 × 22px`). Use `overflow-y: auto` and
  `overscroll-behavior: contain` so wheel input over the accordion does not scroll the whole
  panel at the end of the list. Above about 50 attempts, render the rows through the shared
  `VirtualizedList` (`components/shared/VirtualizedList.tsx`) with the accordion as its
  `scrollContainerRef`. A step with 1000 retries mounts about 10 rows.
- **Expanded state: always collapsed by default; only the user opens it** (decided, see
  [Decisions](#decisions)). Nothing opens or closes the list automatically. That keeps row
  heights stable during a run: nothing below the row jumps while the user reads or aims a
  click, and Part 4's height estimates only change on a user action. State is a plain
  `expandedAttemptTargetKeys: ReadonlySet<string>` in `uiStore`, written only by the chevron.
  It lives in the store, not component state, because virtualization (Part 4) unmounts rows.
  It is session-only. Drop a target's key when a new run of that target starts (a re-run is a
  new step version).
- **The collapsed header is the summary.** It shows the **latest** attempt, so a running step
  on its 4th retry reads that way at a glance without opening anything:

  | State                   | Collapsed header                                                           |
  | ----------------------- | -------------------------------------------------------------------------- |
  | Step running, retrying  | `▸ Retry 3 of 5 · 0:42 ⟳` (denominator from the live `retryStates`)        |
  | Step finished           | `▸ Retry 3 ✓ · 4 attempts`                                                 |
  | Final step, many passes | `▸ Pass 3 · Retry 1 ✓ · 3 passes` (retry part only when that pass retried) |

  Build it from `formatAttemptLabel`, `formatRetryDenominator` (`utils/LimitUtils.ts`) and
  `formatFinalPassLabel`; no new string literals.

- **Two click targets in the header**: the chevron toggles the list, and the label navigates
  the output straight to that latest attempt or pass (`scrollToAttempt` / `scrollToTarget`).
  The common "show me where it is now" case therefore takes one click without expanding.
- **Live behaviour when expanded**: the newest attempt is appended live and the list scrolls to
  it. If the user has scrolled the list up, leave it there until they scroll back to the
  bottom.
- **Row content**: label, duration, token total, and a small status icon (`StatusIcon`, `size`
  scaled down). Add an `InOutputViewBar` per attempt only if Part 3's attempt-level in-view keys
  land (optional; see Follow-ups).

### Final step: pass rows in the expanded footer

- In `FinalStepFooter`'s expanded details, render `StepAttemptList` in **pass mode** when
  `passCount >= 2`. It goes below everything `StepDetailRows` renders (harness/model, stats,
  the override chips row), inside the same content column, so it sits to the left of the
  `ContextWindowBar`, which is the same position as under a normal step. It has one row per
  pass, labelled `formatFinalPassLabel(n)`, with duration, tokens and status. Use the same max
  height of about 5 rows with its own scrollbar, virtualized above the same threshold.

  ```
  review
  Final Step
  ✳ Claude Code · opus
  8:24 · 9eb07c ⧉
  [Interactive] [agent: …] [MCP[ctrlyoke]] [resume] [ec: git status …]
  ▾ Pass 3 ✓ · 3 passes
  ┌───────────────────────────────────────┐
  │ Pass 1            7:02 · 88.1k     ✓  │
  │ Pass 2            9:40 · 120.4k    ✓  │
  │   Initial Attempt 4:11 · 51.0k     ✗  │  ← a pass's retries, indented
  │   Retry 1         5:29 · 69.4k     ✓  │    under that pass
  │ Pass 3            8:24 · 101.9k    ✓  │
  └───────────────────────────────────────┘
  ━━ FINAL STEP  [Pass 3]  👁 Pass 3 ━━━━━━━━━
  ```

- A pass that itself retried shows its attempts as nested, further-indented rows under the
  pass row, inside the same scroller. They are flattened, not a second accordion, so there is
  never a scroller inside a scroller. A pass with a single attempt shows no nested rows.
- The pass list uses the same rules as the queue accordion: collapsed by default, opened only
  by the user, with a collapsed header that summarizes the latest pass.
- The existing per-pass in-view logic (`useFinalStepPassesInOutputView`,
  `outputInViewTargetKeys`) already knows which passes are on screen. Each pass row gets the
  `InOutputViewBar` for free.
- Newest pass at the bottom (chronological, matching the output). When a new pass starts and
  the list has not been scrolled up, keep it pinned to the bottom.

### StepDetailRows cleanup

- **Remove** the running-only `Retry N of M` row (`StepDetailRows.tsx:126`). The collapsed
  accordion header now shows the same thing, so one place shows retry progress both during
  and after the run. `StepDetailRows` no longer needs the `retryState` prop; the accordion
  reads `retryStates` for the live denominator.
- Leave the compact stats row (duration · tokens · session) unchanged. It describes the
  **latest** attempt, which is what `useLatestStepOutput` already returns. State that in the row's
  tooltip ("Latest attempt"), so that once the accordion exists a reader does not take it for a
  sum across attempts.

---

## Part 2b: Final-step pass dividers in the main list

**Recommendation: build it, as a slim divider rather than a full step row, after Parts 1–3.**

### The problem it solves

In a looping workflow, steps appended after a pass run _after_ that pass in the output.
Example: pass 2 ran between steps 15 and 16, and steps 16–17 were appended and ran afterwards.
The output pane is chronological (…15, pass 2, 16, 17, pass 3), but the steps panel puts every
pass in the footer. Scrolling the output from step 15 into pass 2 therefore moves the in-view
marker out of the list and onto the footer ("👁 Pass 2"), past steps 16 and 17 that are still
below it. Scrolling on into step 16 moves it back up. The marker is correct, but the panel's
order no longer matches the output's, so it reads as a jump instead of a steady move down.

A divider row placed where the pass ran makes the panel chronological again, so the marker
moves down in step with the output. It also gives one-click navigation to an earlier pass
without expanding the footer.

### Design

```
15  ✓ 💬 Finish CLI direct-exit sweep
      Codex · gpt-6-luna
──── ⟳ Final Step · Pass 2 · 9:40 ─────────────   ← divider row (slim, ~20px)
16  ✓ 💬 Finish interactive session-error detection
17  ✓ 💬 Route remaining CLI error exits …
━━ FINAL STEP  [Pass 3] ━━━━━━━━━━━━━━━━━━━━━━━━   ← latest pass stays in the footer
```

- **Which passes get one**: only a pass that has queue steps _after_ it in the list (steps
  appended after it ran, done or pending). The trailing pass (pass 3 above) does not, because
  it would sit directly above the footer and repeat it. Workflows that never append steps
  after a pass see no change at all.
- **Position**: derived from output history in the same pass as the attempt index (Part 1). A
  divider goes after the highest queue `stepIndex` with output ordered before that pass's first
  final-step entry. Using the maximum keeps a later rewind and re-run of an earlier step from
  moving the divider.
- **Content**: the final-step icon, `formatFinalPassLabel(n)`, and the duration in muted text.
  It has the same identity rail colour as the footer, and an `InOutputViewBar` while that pass
  is in view, through the existing `outputInViewTargetKeys` key for `{FINAL_STEP, loopIndex}`.
  There is no harness/model/stats block: the footer and its pass list carry the detail.
- **Behaviour**: clicking it navigates to the pass (`scrollToTarget({FINAL_STEP, loopIndex})`)
  and selects the final step, like a footer pass row. It is a native `<button>`. It is not
  draggable, not a droppable, and has no context menu. It always sits in the done section or on
  the done/pending boundary, ahead of the `DndContext`, so the drag model never sees it.
- **Footer marker**: when a divider is in view, the footer's "👁 Pass N" badge still shows.
  The footer is the summary of every pass, and the divider is that pass's place in the
  sequence.
- **Virtualization**: a fourth `StepPanelItem` kind (`passDivider`) with a fixed estimate. It
  is never a drag target.
- **Rejected alternative**: moving whole final-step rows into the list. That duplicates the
  footer's harness, stats, chips and context bar for every pass, and makes the list longer on
  exactly the long looping workflows that Part 4 is trying to speed up.

---

## Part 3: Navigation (P2, P3, P4, P5, P7, P8)

### One click path for all targets

Extend `useStepClickHandler.ts` into a small family that shares one
`navigateOutputTo(target, attempt?)` helper. Callers keep their own selection logic; the
helper handles the deferred `requestAnimationFrame` scroll currently written inline there:

| Click                                              | Selection                                 | Navigation                                                                                                                                              |
| -------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Queue step row                                     | unchanged (`selectPrompt` / multi-select) | latest run's first attempt (`scrollToAttempt(target, {latestRunIndex, 0})`) when `latestRunIndex > 0`, else `scrollToTarget({QUEUE, index})` (fixes P8) |
| Final-step pass divider (Part 2b)                  | `selectFinalStep`                         | `scrollToTarget({FINAL_STEP, loopIndex})`                                                                                                               |
| Attempt row                                        | select the owning step (plain click)      | `scrollToAttempt({QUEUE, index}, {runIndex, attemptIndex})`                                                                                             |
| Final Step row (collapsed bar or expanded details) | `selectFinalStep` (unchanged)             | `scrollToTarget({FINAL_STEP, latestPassLoopIndex})` (**new**, fixes P4)                                                                                 |
| Pass row                                           | `selectFinalStep`                         | `scrollToTarget({FINAL_STEP, loopIndex})`                                                                                                               |
| Pass's nested attempt row                          | `selectFinalStep`                         | `scrollToAttempt({FINAL_STEP, loopIndex}, {...})`                                                                                                       |

- Add `useFinalStepClickHandler()` beside `useStepClickHandler()`, and use it from **both**
  `WorkflowStepsPanel.handleFinalStepSelect` and `StepChipRail.handleFinalStepClick`. These
  are duplicates today and both have the bug.
- `latestPassLoopIndex` = the `loopIndex` of the newest final-step entry in the attempt index,
  not `finalStepLoopCount`. While pass N+1's queue loop is running, the final step has no
  output for that pass yet, so navigation lands on the newest pass that has output. This uses
  the same reasoning as the `useFinalStepLatestOutput` comment. When no pass has output, do not
  navigate (selection still happens).

### Navigation is never gated on editability (P7)

The dashboard is used to watch runs it does not own, so navigation must work in **every**
read-only state. Editing stays blocked. The read-only states, from `HeaderStatusBanner` and the
panel's guards:

| State                                                                    | Source today                                               | Blocks today                                                     |
| ------------------------------------------------------------------------ | ---------------------------------------------------------- | ---------------------------------------------------------------- |
| Run owned by the CLI, another VS Code window, or another external runner | `useActiveWorkflowExternalOwner()` → `isExternallyManaged` | `handleStepClick` returns early: no selection, **no navigation** |
| Commit-message (system-generated) workflow                               | `useIsSystemGeneratedWorkflow()` → `isLineageReadOnly`     | `pointer-events-none` on the whole list: **no clicks at all**    |
| Deleted workflow still on screen                                         | `useIsViewingDeletedWorkflow()` → `isLineageReadOnly`      | same as above                                                    |
| Final step in any of the above                                           | `finalStepSelectionIsReadOnly`                             | `onSelect` skipped, so no navigation once P4 is fixed either     |
| Browsing an older run (history view)                                     | `isViewingHistory`                                         | navigation already works; keep it that way                       |

Changes:

- Split each click handler into **navigate (always)** and **select (gated)**. The shared
  helpers own the split, so the panel, footer, chip rail, attempt rows, pass rows and dividers
  cannot drift apart. `useStepClickHandler` gains an `{ allowSelection }` input; the caller
  passes `!isExternallyManaged && !isLineageReadOnly`. When selection is not allowed, a plain
  click still navigates, and modifier clicks (range/toggle multi-select) do nothing.
- Remove `pointer-events-none` from the list container in the `isLineageReadOnly` case. Keep
  the `opacity-60` dimming, and block editing where it actually happens: drag (`canReorder`),
  set start position, the context menu's mutating items, Delete, paste. Most of these are
  already guarded by `isExternallyManaged`; extend the same guards to `isLineageReadOnly`
  instead of relying on the blanket pointer block. `select-none` can stay.
- `FinalStepFooter`: `isSelectionReadOnly` only gates `onSelect`. The click always calls the
  navigate half, and the footer's cursor and hover styling show it is clickable.
- Tests: in `WorkflowStepsPanel.test.tsx`, cover each row of the table above. A click
  navigates and does not select, and drag, Delete and the start-position button stay
  unavailable.

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
  pass with output, not to `loopCount`, and does not navigate when there is no output. A step
  with a manual re-run navigates to the latest run's first attempt. `allowSelection: false`
  navigates without selecting.
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
  | { kind: "passDivider"; key: string; loopIndex: number; estimate: number } // Part 2b
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
  (no `scrollIntoView` on `data-prompt-index`). Part 5 adds the first such path, and it must
  go through the virtualizer (`scrollToIndex` and item offsets), never a DOM query, because the
  target row may not be mounted.
- **`PauseBoundary`** before the first pending row (`showPauseBoundaryBefore`) stays part of
  that row's item, so it is included in that row's measured height.
- **Lineage read-only overlay**: after Part 3 it is only `opacity-60 select-none` on the scroll
  container. That doesn't interact with virtualization.
- **Context menu / long-press**: these are attached per row and to the container background.
  Unaffected.

---

## Part 5: Steps panel follows the output pane

### Behaviour

- **Following** (the default): as the user scrolls the output pane, the steps panel scrolls
  itself so the step being read stays visible. Fast-scrolling from step 20 into 21 and 22 then
  shows the in-view marker moving down the panel, instead of disappearing below its bottom edge.
- **Manual scroll disarms it**: when the user scrolls the steps panel themselves (wheel,
  touch, scrollbar drag, keyboard) and the step being read leaves the panel's viewport, the
  panel stops following. The user is looking at something else, so the panel stays put.
- **Re-arms when the reader's step is visible again**: following comes back on as soon as
  the step being read is inside the panel's viewport again. That can happen because the user
  scrolled the panel back to it, or because they scrolled the output to a step that happens to
  be on screen in the panel. There is no button or setting; the rule is "the panel follows
  while you can see what it is following".

### Which row is "the step being read"

`outputInViewTargetKeys` (written by `useOutputViewportSteps`) can hold several targets when
short steps share the viewport. The **follow anchor** is the first (topmost) in-view target.
That is the same step the sticky step header shows, so the panel tracks what the output pane
labels as the current step. Expose it from `resolveOutputViewportSteps` as `readingTargetKey`
next to `inViewTargetKeys`, so the rule lives in one place, and store it in `uiStore` as a
primitive (`outputReadingTargetKey: string | null`) so consumers re-render only when it
changes.

Mapping the anchor to a panel item (Part 4's `StepPanelItem[]`):

- Queue step → its `doneStep` / `pendingStep` item.
- Parallel group member → the group's item, offset by the member's position inside the
  group. Use the group item's own measured height; if a member offset is not available yet,
  fall back to the group item as a whole.
- Final-step pass → its `passDivider` item when Part 2b exists. Otherwise the footer, which is
  always visible: nothing to scroll, and following does **not** disarm.

### Scrolling rule

- Keep the anchor row inside a **comfort band**: the panel viewport inset by about one row at
  the top and bottom. While the anchor stays in the band, do nothing, so the panel does not
  move on every frame.
- When the anchor leaves the band, scroll the **minimum** distance that puts it back, so the
  panel moves in step with the output. When the jump is large (the anchor was far off screen,
  for example after a minimap click or a long fling), place the anchor at about one third of
  the viewport instead, which leaves room to see the steps that come next.
- Use `behavior: "auto"` (instant). Smooth scrolling that chases a target updated on every
  output-scroll frame lags behind and stutters. Coalesce to one panel scroll per animation
  frame.
- Compute visibility from the virtualizer's item offsets (`start`/`size` versus the panel's
  `scrollTop`/`clientHeight`), not `getBoundingClientRect`, so unmounted rows work. Scroll with
  `rowVirtualizer.scrollToIndex` (or `scrollToOffset` for a group member offset). Below the
  virtualization threshold, the same offsets come from the non-virtual layout the foundation
  still measures.

### Telling user scrolls from our own

The panel has to tell its own programmatic scrolls apart from the user's, or following would
disarm itself. Mirror `OutputPane`'s approach: mark user intent from
`onWheelCapture` / `onTouchStartCapture` / `onPointerDownCapture` (scrollbar) /
`onKeyDownCapture` on the panel's scroll container. Only a scroll that follows such input
within a short window counts as manual. A scroll event with no recent user input is ours
(or a layout shift) and never disarms.

### When not to follow

- During a step drag (`activeDragId` set): moving the list under the pointer would break
  dnd-kit's collision loop (Part 4). Resume after drop or cancel.
- While a context menu, rename or other panel overlay is open.
- During **programmatic output navigation** that the panel started, such as a step click
  smooth-scrolling the output past ten intermediate steps. Suppress following until the
  navigation controller finalizes (`finalizePendingNavigation`), then apply once for the
  landing target. The clicked row is visible, so following stays armed.
- When the panel is collapsed to the chip rail or hidden (mobile overlay closed). The chip
  rail following the same rule is a follow-up.
- Live autoscroll needs no special case: when the output autoscrolls with a running step, the
  anchor is the running step, so the panel follows the run. This replaces the earlier
  follow-up "reveal the running step".

### Implementation shape

- New hook `hooks/useStepsPanelFollowOutput.ts`, owned by `WorkflowStepsPanel`. Inputs: the
  scroll container ref, the virtualizer, the item list, and `activeDragId`. It keeps
  `isFollowing` in a ref (not state, since nothing renders from it) and subscribes to
  `outputReadingTargetKey` with `useUiStore.subscribe` rather than a render-time selector. Each
  change then runs the scroll check without re-rendering the panel.
- Respect `prefers-reduced-motion` trivially: scrolling is already instant.
- Tests (`test/hooks/useStepsPanelFollowOutput.test.ts`, with stubbed offsets as in the
  `VirtualizedDropdownList` regression test):
  - anchor inside the band → no scroll
  - anchor below the band → minimum scroll; far away → one-third placement
  - wheel input + anchor leaves the viewport → disarmed, and later anchor changes do not
    scroll
  - anchor visible again → re-armed
  - a programmatic scroll does not disarm
  - no scrolling during drag and during panel-initiated output navigation
  - group member and pass-divider anchors

---

## Phasing

Each phase ships on its own, with tests and a `CHANGELOG.md` **Changed** entry where users
would notice:

1. **Navigate/select split + final-step click navigation** (P4, P7): `useFinalStepClickHandler`
   used by both the panel and the chip rail, the `allowSelection` split, and removing the
   blanket `pointer-events-none`. Small and independent; ship first.
2. **Re-collapse fix** in `useOutputRowsModel` (prerequisite for attempt navigation).
3. **Attempt index selector + `StepAttemptList`** for queue steps and final-step passes, with
   navigation at target or pass level (pass rows can already use `scrollToTarget`).
4. **`anchorRowIndexByAttempt` + `scrollToAttempt`**, wired to attempt rows, plus the
   latest-run landing for step clicks (P8).
5. **Pass divider rows** (Part 2b).
6. **Profile, then virtualize the step list**, with drag verification in the dev host.
7. **Steps panel follows the output pane** (Part 5). It comes after virtualization because it
   scrolls through the virtualizer's offsets and `scrollToIndex`. Building it against the
   non-virtual DOM first would mean writing it twice.

Doing phases 3–5 before 6 means the virtualization estimates are written against the final row
shape (accordion and dividers included) rather than revised afterwards.

## Docs

The dashboard UI changes, so update the hand-written docs page covering the steps panel and
final step (find it under `docs/`, likely the dashboard/output guide): attempt rows, pass rows,
click-to-navigate, and the panel following the output. No schema, settings, or persisted-format changes. Everything is derived from
existing output history.

## Decisions

Settled with the user on 2026-11-09:

1. **Accordion default state**: always collapsed, and only the user opens it. The collapsed
   header summarizes the latest attempt or pass ("Retry 3 of 5" while running, "Retry 3 ✓ · 4
   attempts" after), so retry progress is visible without expanding. This replaces an earlier
   "auto-open while running, auto-close when done" design: that design was more state and
   shifted row heights mid-run. The header replaces `StepDetailRows`' running-only
   `Retry N of M` row.
2. **Read-only navigation**: navigation works in every read-only workflow: CLI-owned, owned by
   another VS Code window, commit-message generation, deleted, and history views. Only
   editing is blocked. This applies to the main step row too, not only to attempt and pass rows.
3. **Final-step pass retries**: they appear as indented rows under their pass row, in the pass
   list below the final step's details. That is the same place as under a normal step.
4. **Manual re-runs**: a re-run is a true step modification, not an attempt. A rewind can
   change every property of the step before it re-runs, and continuing crosses an undo
   boundary (`ContinuationBanner`). The output pane keeps every run's output, but the step
   details and attempt list describe only the latest run, and clicking the step lands on that
   run.
5. **Pass divider rows** (Part 2b): recommended. The user's view is that the current
   footer-only behaviour is acceptable, so this is lower priority than Parts 1–4 and can be
   dropped if Part 4's measurements argue against extra rows.
6. **Follow the output** (Part 5): the panel keeps the step being read in view while the user
   scrolls the output. A manual panel scroll that hides that step turns following off, and it
   comes back once the step is visible in the panel again. There is no setting.

## Follow-ups (out of scope)

- Attempt-level in-view markers: extend `outputInViewTargetKeys` with attempt keys so the
  attempt row currently on screen gets an `InOutputViewBar`.
- Apply the same attempt rows to the collapsed `StepChipRail` (e.g. a popover per chip).
- Have the collapsed `StepChipRail` follow the output with Part 5's rule.
