# Final-Step Notation Unification + Running-Row Display Plan

**Status:** Planned — open questions resolved 2026-09-18; ready to implement.

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

**AI-harness spawn path** (`CliTransportCoordinator.getWorkflowStepMetadata`,
`src/core/harness/shared/CliTransportCoordinator.ts:751-776`, consumed at `:243` for a fresh PTY spawn
and at `:363` by `updateCurrentPtySessionMetadata` when a live PTY is reused): the terminal's
`stepIndex` is `workflowContext.promptIndex`, which is `steps.length` for the final step
(`WorkflowExecutor.ts:2157-2160`, `sendPromptIndex`). This is fundamentally an **array index into
`workflowContext.allPrompts`** — used for prompt numbering, `setWorkflowProgress`, and
`CliIntegration.routePromptDiagnostics` (`src/core/harness/CliIntegration.ts:1152-1158`, which compares
`promptIndex < allPrompts.length`). It carries no loop information: it is the same value on final-step
loop 0, 1, 2, ….

**Interactive-script spawn path** (`WorkflowExecutor`'s `spawnScriptPty` call,
`src/core/WorkflowExecutor.ts:2538`): the terminal's `stepIndex` is `signedStepIndex`, from
`getSignedStepIndex()` (`src/core/orchestration/StatusMessageReporter.ts:51-65`), which returns
`-(loopIndex + 1)` for a final-step attempt. This convention was built for the dashboard
status-message/timeline system, which _does_ need loop granularity (retry displays, pre/end-condition
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
  convention is deliberate, well-established, and correctly loop-aware — it is a _design_, unlike the
  `promptIndex`-as-terminal-stepIndex reuse, which was incidental.
- Redesigning final-step loop UI beyond what's needed to show "final step is running" on the running
  list row. Per-loop detail (loop 2 of N) already exists in the open-workflow view
  (`finalStepPhase`/`finalStepLoopCount` in `workflowStore.ts`) and is out of scope here.
- Changing the _recent_ (non-running) row's display. `WorkflowRowLayout`/`RunningWorkflowItem` cover
  the running list only; a completed lineage's last-run summary is a separate data path
  (`RecentWorkflow`) not touched by this plan unless a later phase decides otherwise.

---

## Phase 1 — pick and adopt one final-step terminal-identity notation

### The decision, and the check that settles it

**Option A — reuse the signed-index convention for the terminal's `stepIndex` too.** Stamp the
terminal session's `stepIndex` with `getSignedStepIndex(target)` instead of
`workflowContext.promptIndex`, matching what `spawnScriptPty` already does. Leave
`workflowContext.promptIndex` itself untouched — it has legitimate array-index consumers
(`promptNumber`, `routePromptDiagnostics`) that must keep the "one past the end" semantics.

> **Plumbing detail the first draft of this plan glossed over:** `WorkflowContext`
> (`src/types/WorkflowContextTypes.ts:115`) carries no loop or final-step information at all, so
> `getWorkflowStepMetadata` **cannot** compute a signed index from what it currently receives.
> Option A therefore requires threading the value down. `WorkflowExecutor` already has
> `signedStepIndex` in scope where it builds the context literal (`WorkflowExecutor.ts:2182`, the
> `promptIndex: sendPromptIndex` object), so add one explicit optional field (e.g.
> `terminalStepIndex?: number`) set to `signedStepIndex`, and have `getWorkflowStepMetadata` prefer
> it and fall back to `promptIndex`. Still a small diff, but not the zero-plumbing change implied
> before.

**Option B — stop overloading `stepIndex` for final-step identity at all.** Give `TerminalSession`
(`src/ui/webview-react/store/terminalStore.ts:13`) and the `TERMINAL_STARTED` wire message an explicit
`isFinalStep: boolean` (or `finalStepLoopIndex?: number`) alongside `stepIndex`, and have
`getActiveStepIndices()` / `isTerminalSessionInUseByActiveStep` key off that instead of decoding a
signed integer. Cleaner long-term — no arithmetic decoding, no possible collision with the shell
sentinel ever again, self-documenting at every call site — but touches `PtyProcessManager`, both spawn
paths, the `TerminalStartedMessage` wire shape, and `TerminalSession` in the webview store.

**Blocking check — does one AI-harness PTY span multiple final-step loops?** This decides A vs. B and
must be answered from the code before either is implemented. `promptIndex` is loop-invariant
(`steps.length` on every loop); `-(loopIndex + 1)` is not. If a single retained PTY serves final-step
loops 0, 1, 2 and its `stepIndex` is only stamped at spawn, Option A would _reintroduce_ the very bug
this plan exists to close: `getActiveStepIndices()` would report `-3` on loop 2 while the session still
carries `-1`, and the terminal would again look closeable mid-run.
`CliTransportCoordinator.updateCurrentPtySessionMetadata` (`:363`, called from
`CliExecutionRunner.ts:212`) re-stamps a reused session's metadata, so the question is specifically
whether that refresh fires on _every_ final-step loop, not just on inject-mode re-entry. Trace
`WorkflowExecutor`'s final-step loop → `CliExecutionRunner` → transport coordinator and confirm.

- Refresh covers every loop, or a fresh PTY is spawned per loop → **take Option A.**
- A stamped-once PTY can outlive its loop index → **take Option B**, whose explicit flag is
  loop-invariant by construction.

Record which option was taken, and the evidence for it, in this document.

### Once a notation is chosen

- `WorkflowInstance.getActiveStepIndices()` (`src/core/WorkflowInstance.ts:3768-3793`) collapses back
  to emitting a single value per active final-step attempt instead of two, and its doc comment — which
  currently explains the dual-emission workaround at length — is rewritten to describe the one
  surviving convention.
- `isTerminalSessionInUseByActiveStep`'s doc comment and tests
  (`src/ui/webview-react/utils/terminalPresentation.ts:85-111`,
  `src/ui/webview-react/test/utils/terminalPresentation.test.ts:105-135` — two tests there assert the
  two conventions by name and must become one) update to describe one convention. Keep the
  `session.kind === SESSION_KINDS.AI_CLI` check regardless of which option is chosen — it is the
  actually-correct discriminator ("shell sessions are never step-owned"), not merely a workaround for
  the collision.
- Audit the other raw `stepIndex` consumers on `TerminalSession`. There are two, both in
  `TerminalView.tsx`, and both currently render a **wrong number** for an AI-harness final step:
  `getTerminalStepLabel` (`:45-53`) and the tab badge (`:440-448`) each treat `stepIndex < 0` as "not a
  real step" and fall back to `stepName`, but today's AI-harness final step arrives as `steps.length`
  — a positive value — so a 10-step workflow's final-step terminal labels itself "Step 11". Option A
  fixes this for free (negative ⇒ already handled); Option B must update both sites to check the new
  explicit flag rather than the sign. Either way, pin the final-step terminal's label with a test:
  this is a user-visible fix, not just a refactor.

---

## Phase 2 — final-step awareness on the running-workflow row

### Data: extend `WorkflowSummary`

`WorkflowSummary` (`src/types/CtrlYokeTypes.ts:1200-1229`) currently has no final-step field at all.
Add exactly these two optional fields — and no more; do not add per-loop detail the row will not
render:

```ts
/** Present when the workflow definition has an enabled final step. */
hasFinalStep?: boolean;
/** Set only while the final step is the attempt actually executing right now. */
finalStepRunning?: boolean;
```

### Populate it

- **Local instances**: `WorkflowInstance.getSummary()` (`src/core/WorkflowInstance.ts:1275-1309`) has
  `this.promptQueue.getWorkflowFile().finalStep` and `this.promptQueue.getFinalStepRuntime()`
  (`FinalStepRuntimeState`, `src/types/CtrlYokeTypes.ts:369-377`) available on `this` — the same data
  `sendFullStateToDashboard` already reads (`WorkflowInstance.ts:988`, `:1035`). `hasFinalStep` is
  `!!finalStep && finalStep.enabled !== false`; `finalStepRunning` is
  `finalStepRuntime?.phase === FINAL_STEP_PHASES.FINAL_STEP && finalStepRuntime.status === STEP_STATUS.RUNNING`.
- **External-run watch sessions — resolved: the data _is_ on disk.** The working file's
  `_runtime.finalStep` is a full `FinalStepRuntimeState` (`CtrlYokeTypes.ts:667`), persisted by
  `PromptQueue.persistFinalStepRuntime` and re-read on load (`PromptQueue.ts:497`); the static
  definition sits at `workingFile.finalStep`. External runs are therefore capable of the same live
  running/idle distinction as local ones — they lack it only because the polling code never looks:
  `ExternalRunWatchSession.handleWorkingFileChange`
  (`src/core/orchestration/ExternalRunWatchSession.ts:195-227`) declares a narrow inline type for
  `workingFile` listing only `_runtime.currentIndex`, `_runtime.executionState`,
  `_runtime.tokenTotals` and `steps`. Widen that inline type and the partial-summary payload it emits.
  The two `WorkflowSummary` literals in `ExternalRunWatchCoordinator.ts` (`:504-520`, the initial
  summary, and `:892-898`, the `finalSummary` rebuild) need the same two fields — the latter forcing
  `finalStepRunning: false`, since it describes a finished run.

  > **The first draft's references for this were stale.** It cited `WorkflowOrchestrator.ts:7033` and
  > `:7522`; that file is 4724 lines long, and this code now lives in
  > `src/core/orchestration/ExternalRunWatchCoordinator.ts` / `ExternalRunWatchSession.ts`. Several
  > other citations were similarly off and have been corrected throughout this document — but verify
  > each one against the current code anyway before relying on it.

### Display

- Add a `workflowStepProgressLabel(summary)` helper beside `workflowDisplayStep`
  (`src/types/CtrlYokeTypes.ts:1243-1245` — same file, same single-source spirit) returning the
  existing `"7/10"` shape normally and `"Final step"` when `finalStepRunning` is true. Route both of
  `RunningWorkflowItem`'s display strings through it — the `count` slot (`:242-246`) and the
  accessible name (`:118-125`) — so the visible text and the accessible name can never disagree, which
  is the whole reason `workflowDisplayStep` exists. Leave `WorkflowInstanceRegistry.ts:596` and
  `CtrlYokeWebviewProvider.ts:953` on plain `workflowDisplayStep`; those are log lines, not UI.
- **`metaBadge` conflict — resolved: there isn't one.** The first draft proposed a "Final step" pill in
  `WorkflowRowLayout`'s `metaBadge` slot (`WorkflowRowLayout.tsx:49-59`), which
  `RunningWorkflowItem.tsx:274-283` already occupies with the external-owner badge. Render the
  final-step state through the `count` slot instead: it is already the step-progress slot, `"Final
step"` is precisely step progress, and nothing has to be dropped, widened, or prioritized.
  `metaBadge` stays the external-owner badge's alone.
- **Loop number on the row — resolved: no.** `"Final step"` carries no loop count, consistent with
  `N/N` never having shown retry-attempt numbers either. Per-loop detail stays exclusive to the
  open-workflow view.

### Tests

- `src/test/unit/` (core): `WorkflowInstance.getSummary()` reports `hasFinalStep`/`finalStepRunning`
  correctly across queue-running, final-step-running, and no-final-step workflows; and the
  external-run summary path reports them from a working file carrying `_runtime.finalStep`.
- `src/ui/webview-react/test/components/workflow/`: `RunningWorkflowItem` shows "Final step" instead of
  `N/N` when `finalStepRunning` is true, and the accessible name matches.
- `src/test/unit/CtrlYokeTypes.test.ts`, where `workflowDisplayStep`'s tests already live: the new
  progress-label helper's queue-vs-final-step branches.

## Verification

`npm run typecheck`, `npm run lint`, `npm test` (extension + UI). Do **not** run
`npm run test:harness` — it costs money and is banned by `test.instructions.md`.

Manual check the automated tests cannot fully cover: run a workflow with an enabled final step, watch
the running-workflows dropdown row as it transitions from the last queued step to the final step, and
confirm the row's label updates instead of staying frozen at `N/N`.
