# Final-Step Notation Unification + Running-Row Display Plan

**Status:** Proposed

## Goal

Two related pieces of work, both surfaced by the same investigation (see `fix: gate terminal
deletion correctly for a running final step`):

1. **Unify the final step's internal step-identity notation.** Today two unrelated, independently
   evolved encodings both claim to identify "the final step is running" in a field literally named
   `stepIndex`, and they collide with each other and with the standalone-shell sentinel.
2. **Give the running-workflow list row final-step awareness.** `WorkflowSummary` has no concept of a
   final step at all, so a lineage running its final step displays the frozen `10/10` it showed the
   moment the last queue step finished — indistinguishable from "still on step 10 of 10" or "idle at
   completion".

## Why

While fixing the terminal-deletion gating bug, the two notations turned out to be the actual root
cause: `WorkflowInstance.getActiveStepIndices()` only ever reported queue-step indices, so a running
final step's terminal was never recognized as "in use" and its delete button stayed live mid-execution.
The fix (commit `c4957eb6`) worked around the divergence by emitting both possible values rather than
picking one canonical identity — a correct but ugly patch, and exactly the kind of duplicated-notation
problem `CLAUDE.md`'s DRY/single-source principle calls out. The row-display gap is the same shape of
bug in a different layer: nothing in `WorkflowSummary` distinguishes "on queue step 10 of 10" from "now
running the final step", because nothing upstream computes that distinction once and hands it down.

## Background — the two notations as they exist today

**AI-harness spawn path** (`CliTransportCoordinator.startInteractiveSession` via
`getWorkflowStepMetadata`, `src/core/harness/shared/CliTransportCoordinator.ts:751-776`): the
terminal's `stepIndex` is `workflowContext.promptIndex`, which is `steps.length` for the final step
(`WorkflowExecutor.ts:2154-2157`, `sendPromptIndex`). This is fundamentally an **array index into
`workflowContext.allPrompts`** — used for prompt numbering, `setWorkflowProgress`, and
`CliIntegration.routePromptDiagnostics` (`src/core/harness/CliIntegration.ts:1152-1158`, which compares
`promptIndex < allPrompts.length`). It carries no loop information: it is the same value on final-step
loop 0, 1, 2, ….

**Interactive-script spawn path** (`WorkflowExecutor`'s `spawnScriptPty` call,
`src/core/WorkflowExecutor.ts:2531-2534`): the terminal's `stepIndex` is `signedStepIndex`, from
`getSignedStepIndex()` (`src/core/orchestration/StatusMessageReporter.ts:51-65`), which returns
`-(loopIndex + 1)` for a final-step attempt. This convention was built for the dashboard
status-message/timeline system, which *does* need loop granularity (retry displays, pre/end-condition
reporting, timeline attempts), and is used at a dozen-plus call sites throughout `WorkflowExecutor.ts`.
Negative values let callers detect "this is a final-step event" with `< 0` alone.

**The collision:** `PtyProcessManager.spawnShell` (`src/core/harness/PtyProcessManager.ts:690-696`)
always stamps standalone shell sessions with `stepIndex: -1`. `-(loopIndex + 1)` produces exactly `-1`
on the final step's first loop. Nothing upstream of `spawnScriptPty` had this shell sentinel in mind, so
the two independently-invented conventions overlap. `isTerminalSessionInUseByActiveStep`
(`src/ui/webview-react/utils/terminalPresentation.ts:85-111`) now disambiguates by `session.kind`
(only `ai-cli` sessions are ever step-owned), which is correct and should stay regardless of what
happens below — but the underlying numeric collision is still there, one accidental reuse away from
causing the next version of this bug somewhere else that keys off raw `stepIndex` values.

## Non-goals

- Rewriting the dashboard status-message/timeline system's use of `getSignedStepIndex` wholesale. That
  convention is deliberate, well-established, and correctly loop-aware — it is a *design*, unlike the
  `promptIndex`-as-terminal-stepIndex reuse, which was incidental.
- Redesigning final-step loop UI beyond what's needed to show "final step is running" on the running
  list row. Per-loop detail (loop 2 of N) already exists in the open-workflow view
  (`finalStepPhase`/`finalStepLoopCount` in `workflowStore.ts`) and is out of scope here.
- Changing the *recent* (non-running) row's display. `WorkflowRowLayout`/`RunningWorkflowItem` cover
  the running list only; a completed lineage's last-run summary is a separate data path
  (`RecentWorkflow`) not touched by this plan unless a later phase decides otherwise.

---

## Phase 1 — pick and adopt one final-step terminal-identity notation

### Decision needed (not made in this doc)

**Option A — reuse the signed-index convention for the terminal's `stepIndex` too.** Change
`CliTransportCoordinator`'s PTY spawn to stamp the terminal session's `stepIndex` with
`getSignedStepIndex(target)` instead of `workflowContext.promptIndex`, matching what
`spawnScriptPty` already does. Leave `workflowContext.promptIndex` itself untouched — it has
legitimate array-index consumers (`promptNumber`, `routePromptDiagnostics`) that must keep the
"one past the end" semantics. This only touches the *terminal session's own* `stepIndex` field.
Smaller diff; reuses plumbing that already exists everywhere else. Loses nothing, since AI-harness
final-step sessions apparently don't currently need per-loop terminal identity (one continuous PTY
spans the whole final step today) — confirm this assumption holds before adopting.

**Option B — stop overloading `stepIndex` for final-step identity at all.** Give `TerminalSession`
(and the `TERMINAL_STARTED` wire message) an explicit `isFinalStep: boolean` (or
`finalStepLoopIndex?: number`) alongside `stepIndex`, and have `getActiveStepIndices()` /
`isTerminalSessionInUseByActiveStep` key off that instead of decoding a signed integer. Cleaner
long-term — no arithmetic decoding, no possible collision with the shell sentinel ever again,
self-documenting at every call site — but touches `PtyProcessManager`, both spawn paths, the
`TerminalStartedMessage` wire shape, and `TerminalSession` in the webview store.

Recommendation to weigh during implementation: Option A is the pragmatic single-source fix (one
function, `getSignedStepIndex`, becomes the only place "final step" is encoded as a number,
matching the project's DRY principle) and should be tried first; fall back to Option B only if
per-loop terminal identity turns out to already be needed somewhere Option A can't reach.

### Once a notation is chosen

- `WorkflowInstance.getActiveStepIndices()` (`src/core/WorkflowInstance.ts:4822-4841`) collapses back
  to emitting a single value per active final-step attempt instead of two.
- `isTerminalSessionInUseByActiveStep`'s doc comment and tests
  (`src/ui/webview-react/utils/terminalPresentation.ts`,
  `src/ui/webview-react/test/utils/terminalPresentation.test.ts`) update to describe one convention.
  Keep the `session.kind === SESSION_KINDS.AI_CLI` check regardless of which option is chosen — it is
  the actually-correct discriminator ("shell sessions are never step-owned"), not merely a workaround
  for the collision.
- Audit other raw `stepIndex` consumers on `TerminalSession` for the same assumption —
  `getTerminalStepLabel` in `TerminalView.tsx:45-53` already treats `stepIndex < 0` as "not a real
  step" and falls back to `stepName`; confirm it still reads correctly under whichever notation wins
  (Option A: final step is always negative, already handled; Option B: would need updating to check
  `isFinalStep` instead of the sign).

---

## Phase 2 — final-step awareness on the running-workflow row

### Data: extend `WorkflowSummary`

`WorkflowSummary` (`src/types/CtrlYokeTypes.ts:1170-1199`) currently has no final-step field at all.
Add something like:

```ts
/** Present when the workflow definition has an enabled final step. */
hasFinalStep?: boolean;
/** Set only while the final step is the attempt actually executing right now. */
finalStepRunning?: boolean;
```

(Exact shape TBD — could instead mirror `workflowStore.ts`'s `finalStepPhase`/`finalStepStatus` pair
if per-loop detail on the row ever becomes desirable, but the row only needs a boolean today; don't
add fields the UI won't use.)

### Populate it

- **Local instances**: `WorkflowInstance.getSummary()` (`src/core/WorkflowInstance.ts:1318-1350`) has
  `this.promptQueue.getWorkflowFile().finalStep` and `this.promptQueue.getFinalStepRuntime()`
  (`FinalStepRuntimeState`, `src/types/CtrlYokeTypes.ts:367-375`) already in scope — this is the same
  data `sendFullStateToDashboard` already reads (`WorkflowInstance.ts:1036-1037`). `hasFinalStep` is
  `!!finalStep && finalStep.enabled !== false`; `finalStepRunning` is
  `finalStepRuntime?.phase === FINAL_STEP_PHASES.FINAL_STEP && finalStepRuntime.status === STEP_STATUS.RUNNING`.
- **External-run watch sessions**: `WorkflowOrchestrator.ts:7033` and the `finalSummary` rebuild at
  `WorkflowOrchestrator.ts:7522-7530` build `WorkflowSummary` from a polled `workingFile` on disk, not
  live runtime state. Check what `workingFile._runtime` actually carries for final-step phase/status
  in the external-run case before assuming parity with the local path — it may only support
  `hasFinalStep` (static, from `workingFile.finalStep`) without a live running/idle distinction, in
  which case the row shows "has a final step" but not "is on it right now" for externally-owned runs.
  Confirm during implementation rather than assuming.

### Display

- Add a `workflowStepProgressLabel(summary)`-style helper beside `workflowDisplayStep`
  (`src/types/CtrlYokeTypes.ts:1208-1215`, same file, same single-source spirit) that returns the
  existing `"7/10"` shape normally and something like `"Final step"` when `finalStepRunning` is true,
  so every caller of `workflowDisplayStep` for *display* text (today just
  `RunningWorkflowItem.tsx:242-246`, plus the accessible-name string at `:121-122`) goes through one
  function instead of each row kind growing its own final-step conditional.
- **Conflict to resolve**: `WorkflowRowLayout`'s `metaBadge` slot (`WorkflowRowLayout.tsx:49-59`) looks
  like the natural home for a "Final step" pill — it already exists for exactly this
  "small fixed-content pill in the meta line" purpose — but `RunningWorkflowItem.tsx:274-283` already
  uses it for the external-owner badge. Decide the priority (external-owner badge wins, since it's
  rarer and more load-bearing for read-only affordance; or show both side by side if `metaBadge` is
  widened to accept multiple children) before implementing — don't silently drop one.
- Update `accessibleName` (`RunningWorkflowItem.tsx:118-125`) to say "final step" instead of
  "step 10 of 10" when applicable, for the same reason `workflowDisplayStep` exists: the visible text
  and the accessible name must never disagree.

### Tests

- `src/test/unit/` (core): `WorkflowInstance.getSummary()` reports `hasFinalStep`/`finalStepRunning`
  correctly across queue-running, final-step-running, and no-final-step workflows.
- `src/ui/webview-react/test/components/workflow/`: `RunningWorkflowItem` shows "Final step" (or
  whatever label wins) instead of `N/N` when `finalStepRunning` is true, and the accessible name
  matches.
- `src/ui/webview-react/test/utils/` (or beside `workflowDisplayStep`'s existing tests, if any): the
  new progress-label helper's queue-vs-final-step branches.

---

## Open questions

1. **Option A vs. Option B for Phase 1** — see above. Try A first; only reach for B if a concrete need
   for per-loop terminal identity in the AI-harness path surfaces.
2. **Do external-run summaries have live final-step phase data, or only the static "has a final step"
   flag?** Determines whether externally-owned running rows can show "final step running" at all, or
   only "has a final step" (e.g. as a dimmer/different-styled badge).
3. **`metaBadge` slot conflict** with the external-owner badge — resolve before implementing, not
   during.
4. **Does the final step's loop count belong on the row at all**, or is "Final step" (no loop number)
   sufficient for the collapsed list view, with per-loop detail staying exclusive to the open-workflow
   view? Leaning toward no loop number on the row — keeps it consistent with how `N/N` never showed
   retry-attempt numbers either.

## Verification

`npm run typecheck`, `npm run lint`, `npm test` (extension + UI). Do **not** run
`npm run test:harness` — it costs money and is banned by `test.instructions.md`.

Manual check the automated tests cannot fully cover: run a workflow with an enabled final step, watch
the running-workflows dropdown row as it transitions from the last queued step to the final step, and
confirm the row's label/badge updates instead of staying frozen at `N/N`.
