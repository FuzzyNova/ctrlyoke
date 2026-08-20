# Status Message Persistence Plan

> **Status:** Phases 1–5 complete; phase 6 remains. Spec audited against the code on 2026-08-20 —
> see "Corrections from the code audit" below; the audit changed phases 4, 5
> and 6, so read it before implementing any phase. One instance of the bug this plan targets was
> already fixed as a narrow patch (`WorkflowInstance.executeLoadedPromptFile`'s
> "Execution failed" row, 2026-08-20) — this document is the follow-up
> redesign so the *class* of bug can't recur, requested directly after that
> patch landed.
> **Priority:** P2 — not data loss, but a real, repeatedly-reintroduced UX gap
> (a user navigating away and back, or starting a new run, loses the exact
> diagnostic they needed to see).
> **Origin:** Investigating why an "Execution failed: …" row disappeared after
> switching workflows and back surfaced that the live dashboard push and the
> history-persistence write for a status message are two independent calls,
> at every call site, with nothing enforcing that a caller remembers both. One
> call site (the top-level execution-failure catch in `WorkflowInstance`) had
> forgotten the second half. The question this plan answers: how many other
> call sites have the same gap, and what structural change makes it
> impossible for a *new* call site to introduce it again.

## Problem

A "status message" — a warning or error row shown in the Output pane, tagged
to a step or the final-step loop — has two independent effects today, and
nothing ties them together:

1. **Live push**: `IDashboardSink.updateStatusMessage(stepIndex, message,
   severity, workflowId?, timestampMs?)`, which the currently-viewing webview
   renders immediately.
2. **Persistence**: `OutputHistoryManager.appendStatusMessage(historyFilePath,
   target, statusMessage)`, which writes the row into the run's timeline so
   it survives a reload — switching workflows and back, restarting the
   extension host, or opening the run from history later.

Every caller that wants a status message to *survive* has to remember to call
both, with the right target-encoding for each (`updateStatusMessage` takes a
signed `stepIndex`; `appendStatusMessage` takes an `OutputExecutionTarget`
object). Nothing in the type system or the call shape suggests the second
call is required — `dashboardSink?.updateStatusMessage(...)` type-checks and
runs fine on its own, silently live-only.

### This logic is independently reimplemented at least four times

Confirmed by reading each site directly:

| Site | Pairs live push with persistence? |
| --- | --- |
| `WorkflowExecutor.trackStatusMessage` (`WorkflowExecutor.ts:1761-1807`) | Yes — the one caller-facing helper that already gets this right, but it's private to `WorkflowExecutor` and only `WorkflowExecutor`'s own step-lifecycle messages go through it. |
| `ScriptExecutionReporter.emitStatus` (`ScriptExecutionReporter.ts:393-434`) | Yes — a second, independently-written copy of the same "push, then `if (context.historyFilePath && context.outputHistoryManager) …`" shape. |
| `WorkflowInstance.reportCompatibilityDiagnostics` (`WorkflowInstance.ts:637-694`) | Yes, but via a third shape: two separate dedup `Set`s (`reportedCompatibilityDiagnosticKeys`, `persistedCompatibilityDiagnosticKeys`) because the first call can happen before a history file exists (preflight) and a later call must still persist once one does. |
| `WorkflowInstance`'s four direct call sites (worktree notice `:1996-2015`, missing-secret preflight warning `:1970-1994`, and — until the 2026-08-20 patch — the top-level execution-failure catch `:2114-2150`) | Hand-written each time, correct three-of-four times *by copying the pattern*, wrong once. |
| `EndConditionHandler` (`EndConditionHandler.ts:277-281`, `:378-382`) | **No.** Only has `getDashboard(): () => IDashboardSink \| undefined` in its constructor; no path to `outputHistoryManager`/`historyFilePath` at all. |
| `PromptFileLoader` (`PromptFileLoader.ts:403-412`) | **No.** Same shape as `EndConditionHandler` — `getDashboard()` only. |

So the count is: one correct shared helper (`trackStatusMessage`, scoped too
narrowly to cover everything), one independent reimplementation that also
gets it right (`ScriptExecutionReporter.emitStatus`), one independent
reimplementation with its own bespoke dedup semantics
(`reportCompatibilityDiagnostics`), one class with the right access but where
a copy-pasted call site forgot the second half (the bug this plan follows
up on), and two classes (`EndConditionHandler`, `PromptFileLoader`) that
structurally *cannot* persist today because they were only ever given a
dashboard handle.

### Why `EndConditionHandler` and `PromptFileLoader` don't just get an `outputHistoryManager` reference

Both are constructed **once per `WorkflowInstance`**, at object-construction
time (`WorkflowInstance.ts:505`, `:3799` for `EndConditionHandler`), not once
per run. `historyFilePath` doesn't exist yet at that point and changes on
every run — it's `undefined` until a run starts, then a fresh value each
time `executeLoadedPromptFile` promotes or resumes a run
(`this.activeHistoryFilePath = historyFilePath;` at `WorkflowInstance.ts:4110`
inside `startWorkflowExecution`). That's exactly why these two classes
already take `getDashboard: () => IDashboardSink | undefined` — a *getter
closure* — instead of a plain `IDashboardSink` field: the dashboard sink
itself is stable across runs, but if it weren't, the same closure shape would
still work. A raw `historyFilePath: string` constructor field would go stale
the moment the second run starts; that's the "threading `getHistoryContext`
through everywhere feels a bit wrong" instinct from the request that started
this document, and it's correct — a **value** shouldn't be threaded through a
constructor when it changes shape more often than the object's lifetime.

## Product Decision

Don't thread a raw, run-scoped value into long-lived constructors. Instead,
introduce **one small stateful service, constructed once per `WorkflowInstance`
alongside `dashboardSink`/`outputHistoryManager`, that is the only supported
way to raise a status message.** Every current call site — including the two
classes that can't reach history today — gets a reference to *this one
service* instead of a raw dashboard handle, and the service internally
resolves "is a history file active right now" via a getter closure exactly
like the `getDashboard` closure they already receive. Callers stop having two
things to remember and get exactly one method to call; there is no code path
left that pushes a status message live without at least *attempting* to
persist it.

### The shape: `StatusMessageReporter`

New file, `src/core/orchestration/StatusMessageReporter.ts` (sibling to
`OutputHistoryManager.ts` and `ScriptExecutionReporter.ts`, which already
live in this directory and already juggle this exact pair of concerns):

```ts
export interface WorkflowEventTarget {
  kind: typeof FINAL_STEP_PHASES.QUEUE | typeof FINAL_STEP_PHASES.FINAL_STEP;
  stepIndex?: number; // required when kind === QUEUE
  loopIndex?: number; // required when kind === FINAL_STEP
}

export interface StatusMessageReportOptions {
  timestampMs?: number;
  /** Live push fires at most once per key, for this reporter's lifetime
   *  (until `resetDedupeState()`). Omit for "always push". */
  liveDedupeKey?: string;
  /** Persisted write fires at most once per key, independently of the live
   *  dedupe — this is what lets a preflight-time fact (raised before any
   *  history file exists) still get written once a run starts. Omit for
   *  "always persist while a history file is active". */
  persistDedupeKey?: string;
}

export class StatusMessageReporter {
  constructor(
    private readonly getDashboard: () => IDashboardSink | undefined,
    private readonly getActiveHistorySink: () =>
      | { filePath: string; manager: OutputHistoryManager }
      | undefined,
    private readonly workflowId?: string
  ) {}

  report(
    target: WorkflowEventTarget,
    message: string,
    severity: StatusMessageSeverity,
    options?: StatusMessageReportOptions
  ): void {
    /* push live (honoring liveDedupeKey), then persist (honoring
       persistDedupeKey, no-op when getActiveHistorySink() returns
       undefined) — see "Behavior" below for the exact semantics. */
  }

  /** Call at the start of a genuinely fresh run — mirrors today's two
   *  `.clear()` calls at WorkflowInstance.ts:1555-1556. */
  resetDedupeState(): void {}
}
```

`WorkflowInstance` constructs exactly one of these (alongside `dashboardSink`
and `outputHistoryManager`, same lifetime) and hands it — not `getDashboard`
— to everything that currently takes `getDashboard` for status-message
purposes: its own direct call sites, `EndConditionHandler`'s constructor,
`PromptFileLoader`'s constructor, and `WorkflowExecutionContext` (so
`WorkflowExecutor.trackStatusMessage` and `ScriptExecutionReporter.emitStatus`
delegate to it too, instead of each keeping its own copy of the same logic).

### Behavior, precisely

- **No dedupe keys (the common case — worktree notice, missing-secret
  warning, execution-failure row, `EndConditionHandler`'s two sites,
  `PromptFileLoader`'s warning, every `trackStatusMessage`/`emitStatus`
  caller today):** every `report()` call pushes live *and* attempts to
  persist. This is `trackStatusMessage`'s and `emitStatus`'s existing
  behavior, now shared instead of duplicated.
- **Both keys set, identical (`reportCompatibilityDiagnostics`'s case):**
  reproduces today's two-independent-`Set` behavior exactly — live push
  fires once ever per key, persistence fires once ever per key, and because
  they're independent, a diagnostic raised during preflight (before any
  history file exists) still gets a live push immediately and a persisted
  write the *first later call* where `getActiveHistorySink()` is non-`undefined`
  — without a second, redundant live push. This is why the primitive takes
  two independent keys instead of one: collapsing them would either
  re-push live on every subsequent call (noisy) or skip persistence
  entirely once the live-dedupe had already fired once before history
  existed (the exact bug this plan is about, reintroduced one level up).
- **`getActiveHistorySink()` returns `undefined`:** the persist half is a
  silent no-op, same as `context.historyFilePath && context.outputHistoryManager`
  being falsy today. Never throws, never blocks the live push.
- Persist failures are caught and `Log.warn`'d inside the reporter, matching
  every existing call site's `.catch(...)` — a history write failure must
  never take down the step that triggered the message.

### Alternative considered and rejected: decorate the sink instead

An earlier shape considered for this document: wrap the real
`IDashboardSink` in a decorator whose `updateStatusMessage` always also
persists, and keep every existing call site's code unchanged (just swap what
object `this.dashboardSink` points to). This is *less* invasive — zero call
sites change — but it breaks `reportCompatibilityDiagnostics`'s two-phase
behavior: that method's whole reason for two dedup sets is that it
deliberately calls `updateStatusMessage` **only once, ever, per fact** (to
avoid spamming the live feed on every re-report), while still needing
persistence to fire *later*, the first time a history file exists. A
decorator only sees the calls that actually reach it — if the live push is
already deduped away above the decorator, the decorator never runs a second
time to catch the persist-later case, and that behavior silently regresses.
The explicit-service shape above doesn't have this problem because dedupe
lives inside the one place that already knows about both operations.

### Answering the request directly

> threading `getHistoryContext` through everywhere feels a bit wrong

Agreed, and the reason is specific: a raw value (`historyFilePath: string`)
threaded into a long-lived constructor goes stale the moment the next run
starts, so it was never going to be the right shape regardless of how many
places it reached. The fix isn't "thread the raw context more carefully" —
it's "callers never see the raw context (dashboard sink + history file +
history manager) at all; they see one always-both-halves operation." That
also means this plan does not add a new closure parameter next to
`getDashboard` — it *replaces* `getDashboard` everywhere the only reason a
caller had it was to call `updateStatusMessage`.

## Corrections from the code audit (2026-08-20)

Every line reference in this document was re-checked against the current
tree before staging. Four things in the original write-up are wrong or
incomplete; the phase table below has been amended accordingly.

### 1. A status message has *three* effects, not two

The "Problem" section above describes live push + persistence. There is a
third, and it is the one most likely to be silently dropped by phase 5:

3. **Buffered replay / event fan-out**:
   `WorkflowExecutionContext.onStatusMessage(stepIndex, message, severity)`
   and `onFinalStepStatusMessage(loopIndex, message, severity)`. Both
   `WorkflowExecutor.trackStatusMessage` (`WorkflowExecutor.ts:1797-1799`)
   and `ScriptExecutionReporter.emitStatus`
   (`ScriptExecutionReporter.ts:418-422`) fire one of these *between* the
   live push and the persist. In `WorkflowInstance` they land on
   `_workflowStatusMessageEmitter` (`WorkflowInstance.ts:3597-3603`,
   consumed by `cli.ts:633`) and, for the finalStep variant, on
   `OutputCaptureBuffer.onFinalStepStatusMessage`
   (`WorkflowInstance.ts:3590-3596`), which buffers the message for replay
   to a reconnecting dashboard (`OutputCaptureBuffer.ts:326-336`, replayed
   at `:424-447`).

   Consequence for phase 5: `report()` must carry this effect too, or
   delegating `trackStatusMessage`/`emitStatus` to the reporter silently
   loses CLI status output and finalStep reconnect-replay. The reporter
   therefore takes a third constructor closure alongside `getDashboard` and
   `getActiveHistorySink`:

   ```ts
   private readonly notifyStatusMessage?: (
     target: WorkflowEventTarget,
     message: string,
     severity: StatusMessageSeverity
   ) => void
   ```

   `WorkflowInstance` wires it to the same two callbacks it already passes
   into `WorkflowExecutionContext`, dispatching on `target.kind`. This is a
   deliberate, small behavior *addition* for `WorkflowInstance`'s own four
   direct call sites and for `EndConditionHandler`/`PromptFileLoader`, which
   fire no notification today — their messages become visible to the CLI
   consumer and (for finalStep targets) replayable, which is the same gap in
   a different coat. Call it out in the commit message; it is intended.

### 2. `PromptFileLoader.getDashboard` cannot be replaced, only added to

Phase 4's "replace `getDashboard` with the shared reporter" is wrong for
this class. `PromptFileLoader` uses its dashboard handle for three
*non*-status calls — `updateFileSelected` (`:221`), `updateSessionRestored`
(`:302`), and the STEPS_EXTENDED merge push (`:329`) — in addition to the
one `updateStatusMessage` at `:405`. Keep `getDashboard` and **add** the
reporter as a new constructor parameter.

`EndConditionHandler` is the opposite and the spec is right about it: its
`getDashboard` (`:97`) is only ever used for `updateStatusMessage` (`:277`,
and `:368`'s `retryDashboard` which is used solely at `:378`), so that
parameter can be swapped outright.

### 3. `EndConditionHandler` is constructed twice in production

`WorkflowInstance.ts:505` (constructor) and `:3799` (rebuild when the
execution workspace changes). Both must receive the **same** reporter
instance — dedupe state lives in the reporter, and handing the rebuild a
fresh one would re-fire already-reported facts mid-lineage. Construct the
reporter right after `this.outputHistoryManager` is assigned
(`WorkflowInstance.ts:488`) so it is available at both sites.

Constructor-site counts for the test sweep, measured not estimated:
`new EndConditionHandler` — 21 occurrences across `WorkflowInstance.ts`,
`EndConditionHandler.test.ts`, `WorkflowExecutor.test.ts`,
`mixedModeExecution.integration.test.ts`, `interactiveScriptStep.test.ts`.
`new PromptFileLoader` — 8 occurrences (`WorkflowInstance.ts:518` plus 7 in
`PromptFileLoader.test.ts`).

### 4. `OutputCaptureBuffer` is a fifth `updateStatusMessage` caller — and a phase-6 exemption

`OutputCaptureBuffer.ts:427-446` calls `updateStatusMessage` while replaying
buffered finalStep messages to a dashboard that just (re)connected. It is
**not** a status-raising event — the message was already raised, pushed and
persisted through the normal path — so it must be exempt from the phase-6
lint rule alongside the transport-layer implementations, and it must not be
migrated onto the reporter (doing so would re-persist every replayed row on
every reconnect). Note that it reaches the method through an inline
`as { updateStatusMessage?: ... }` structural cast, which the repo's
"make structural relationships nominal" principle forbids; phase 6 should
narrow that to the real `IDashboardSink` type while adding the exemption,
since a cast like that also hides the call from the lint rule.

### 5. Passing `this.id` as `workflowId` everywhere is inert (verified)

`trackStatusMessage`/`emitStatus` pass `undefined` for `workflowId` while
`WorkflowInstance`'s direct sites pass `this.id`. Unifying on the workflow
id inside the reporter is safe: `this.dashboardSink` is already a
`WorkflowTaggedSink` constructed with `this.id`
(`WorkflowInstance.ts:465`), and its `updateStatusMessage` discards the
caller-supplied argument in favour of its own tag
(`WorkflowTaggedSink.ts:227-240`).

## Staged execution plan

| # | Step | Closes |
| --- | --- | --- |
| 1 | **Done.** Add `StatusMessageReporter` + `WorkflowEventTarget`/`StatusMessageReportOptions` types, with full unit coverage (live-only when no history sink, both when active, independent live/persist dedupe keys, `resetDedupeState()`). No production call site changes yet. | New primitive exists and is proven correct in isolation. |
| 2 | **Done.** `WorkflowInstance` constructs one `StatusMessageReporter`; its four direct call sites (compatibility diagnostics, worktree notice, missing-secret warning, execution-failure row) use it; `resetDedupeState()` replaces the old compatibility sets' clear calls; the two sets and hand-rolled persistence/live fan-out are gone. The execution-failure path preserves its explicit `runToFinalize` destination when it differs from the normal active-history resolver. | The original bug class, inside the file it was found in. |
| 3 | **Done.** `EndConditionHandler`: replace the `getDashboard` constructor param with the shared reporter; migrate its two call sites (`:277-281` end-condition-failed error, `:378-382` retry-in-progress notice). Update every test construction site (`EndConditionHandler.test.ts`, `WorkflowExecutor.test.ts`, `mixedModeExecution.integration.test.ts`, `interactiveScriptStep.test.ts` — 21 call sites) to pass a reporter (a no-op reporter for tests that don't care, matching today's `() => undefined`). | The two structurally-unpersisted sites found in the prior investigation. |
| 4 | **Done.** `PromptFileLoader` adds the shared reporter while retaining `getDashboard` for its three non-status calls, migrates the missing-assets warning, preserves headless logging with an unconditional `Log.warn`, and exposes the last missing-directories list. `WorkflowInstance` re-reports that warning after `EXECUTION_STARTED` resolves a history path, using independent live/persist dedupe so the original load-time push fires once and the persisted write lands once. | The genuinely harder case — a warning raised before a run exists at all — instead of leaving it as a documented exception. |
| 5 | **Done.** `WorkflowExecutor.trackStatusMessage` and `ScriptExecutionReporter.emitStatus` keep their existing signatures but delegate through the instance-owned reporter. The reporter retains the extension-clock timestamp and dispatches queue/final-step notification fan-out before persistence; both execution contexts require that shared instance. | Removes the two remaining independent reimplementations; from here on there is exactly one. |
| 6 (stretch, optional) | Add an ESLint `no-restricted-syntax` (or equivalent) rule forbidding direct `.updateStatusMessage(` calls outside `StatusMessageReporter.ts` and the sink-transport layer itself (`WorkflowTaggedSink.ts`, `DashboardBroadcastHub.ts`, `PostMessageDashboardSink.ts`, `CtrlYokeWebviewProvider.ts`, `CtrlYokeHostedServer.ts` — these *implement* `IDashboardSink.updateStatusMessage`, they don't call it as a status-raising event, and must stay exempt — plus `OutputCaptureBuffer.ts`, which *replays* already-raised messages and must also stay exempt, see correction 4). This is what upgrades "consolidated" to "structurally hard to reintroduce" — a new call site that reaches for the sink directly fails lint instead of silently shipping a live-only warning. | Makes the fix durable against future call sites, not just the ones known today. |

Phases 1–5 are the correctness work; phase 6 is what actually satisfies
"impossible to hit going forward" for code written after this lands, and
should not be skipped if the team wants that guarantee rather than just a
cleaner refactor.

## Open design questions for the implementer

1. **Does `StatusMessageReporter` ever need to be `undefined`?** Today's
   `getDashboard` defaults to `() => undefined` in several test call sites
   and in headless/CLI construction paths without a live dashboard. Recommend
   the reporter is **never optional** — always construct one, and let it
   internally no-op when `getDashboard()` returns `undefined` (it already has
   to handle "no history sink" the same way). This removes a second layer of
   optional-chaining (`context.statusReporter?.report(...)`) at every call
   site for no behavior difference.
2. **Where does `EndConditionHandler` get the reporter from, concretely?**
   It's constructed directly by `WorkflowInstance` (`:505`, `:3769`), not by
   `WorkflowExecutor`, so pass the same instance-owned reporter into its
   constructor the same way `getDashboard` is passed today — no new plumbing
   shape, just a different payload behind the existing parameter position.
3. **`resetDedupeState()` call site.** Confirm it must fire in exactly the
   same condition as today's two `.clear()` calls
   (`!continueFromCurrent && !isAppendContinuation && !isIdleContinuation`,
   `WorkflowInstance.ts:1554`) — a continuation/append/resume must **not**
   reset dedupe, or a fact already reported for the still-running lineage
   would spuriously re-fire.

### Phase 1 design decisions

- `StatusMessageReporter` is always constructed and is never optional; absent
  dashboard/history sinks are handled as internal no-ops.
- Persistence dedupe keys are recorded only once an active history sink exists,
  so a preflight report can persist on the first later call after a run starts.
- `WorkflowExecutor` keeps its existing private conversion methods for phase-1
  compatibility, but delegates their encoding to the reporter's exported
  helpers so signed-index logic has one implementation.

## Testing

- Unit (`StatusMessageReporter.test.ts`, new): live push with no history
  sink persists nothing; live push with an active history sink persists;
  `liveDedupeKey` suppresses a second live push but not persistence;
  `persistDedupeKey` suppresses a second persisted write but not the live
  push; a persist failure is caught and does not throw out of `report()`;
  `resetDedupeState()` allows both keys to fire again.
- Unit: `WorkflowInstance`'s four migrated call sites still produce the same
  live + persisted pair the existing tests already assert (the execution-
  failure test extended on 2026-08-20 in `WorkflowInstance.test.ts` is the
  template — assert persisted message/severity/filePath match the live push).
- Unit: `EndConditionHandler`'s two migrated sites persist to history when a
  history sink is active (new coverage — today's tests only assert the live
  push).
- Unit: `PromptFileLoader`'s missing-assets warning is re-reported once a
  history file becomes active, and the persisted write lands with the
  original message text.
- Regression: `reportCompatibilityDiagnostics`'s existing "reported only
  after EXECUTION_STARTED" test (if one exists) continues to pass unchanged
  through the shared primitive — this is the case most likely to regress
  silently if the two-dedupe-key design is simplified during implementation.

## Files likely changed

| File | Change |
| --- | --- |
| `src/core/orchestration/StatusMessageReporter.ts` | New. The shared primitive. |
| `src/test/unit/StatusMessageReporter.test.ts` | New. Primitive unit coverage. |
| `src/core/WorkflowInstance.ts` | Construct the reporter; migrate 4 direct call sites + `reportCompatibilityDiagnostics`; delete the two dedup `Set`s; call `resetDedupeState()`; pass the reporter into `EndConditionHandler`/`PromptFileLoader` construction and into `WorkflowExecutionContext`. |
| `src/core/EndConditionHandler.ts` | Constructor param swap; migrate 2 call sites. |
| `src/core/orchestration/PromptFileLoader.ts` | Constructor param **added** (not swapped — `getDashboard` stays for its three non-status uses); migrate 1 call site; add `getLastMissingAssetDirectories()` for the re-report phase. |
| `src/core/WorkflowExecutor.ts` | `WorkflowExecutionContext` gains `statusReporter`; `trackStatusMessage` delegates instead of duplicating. |
| `src/core/orchestration/ScriptExecutionReporter.ts` | `ScriptExecutionReporterContext` gains `statusReporter`; `emitStatus` delegates instead of duplicating. |
| `src/test/unit/PromptFileLoader.test.ts` (7 constructor sites) | Update constructor call sites. |
| `src/test/unit/WorkflowInstance.test.ts`, `EndConditionHandler.test.ts`, `WorkflowExecutor.test.ts`, `src/test/integration/mixedModeExecution.integration.test.ts`, `src/test/unit/interactiveScriptStep.test.ts` | Update constructor call sites; add persistence assertions where only live-push was checked before. |
| `.github/instructions/core.instructions.md` | Replace the interim "known, not-yet-fixed instances" bullet (added 2026-08-20) with a description of `StatusMessageReporter` as the single funnel point, once phases 1–5 land. |
| `eslint.config.mjs` (phase 6 only) | New `no-restricted-syntax` rule, with the transport-layer + `OutputCaptureBuffer` exemption list. |
| `src/core/OutputCaptureBuffer.ts` (phase 6 only) | Replace the inline structural cast at `:427` with the real `IDashboardSink` type so the replay call is visible to the lint rule and covered by the exemption. |
