# Script Output Unification — one rendering pipeline for script steps, pre-conditions, and end-conditions

Status: **Proposed (2026-07-25).** Not implemented. Interlocks with
[`ON_ERROR_REDESIGN_PLAN.md`](./ON_ERROR_REDESIGN_PLAN.md) — see "Relationship to
the On Error plan".

## Problem

ctrlyoke runs user scripts from four places, all through the same evaluator
(`EndConditionEvaluator.evaluateCondition`, `EndConditionEvaluator.ts:154`), but
their output reaches the dashboard through two completely different pipelines:

| Caller                | Site                         | Streams? | Rendered as                                           | Persisted as                                   |
| --------------------- | ---------------------------- | -------- | ----------------------------------------------------- | ---------------------------------------------- |
| Script step           | `WorkflowExecutor.ts:806`    | **yes**  | CLI output group (header/command/response/stats rows) | CLI timeline entry + `scriptExecutionRecorded` |
| Pre-condition         | `WorkflowExecutor.ts:487`    | no       | one `StatusMessage` string                            | status timeline entry                          |
| End-condition         | `WorkflowExecutor.ts:1720`   | no       | one `StatusMessage` string                            | status timeline entry                          |
| End-condition retries | `EndConditionHandler.ts:407` | no       | one `StatusMessage` string                            | status timeline entry                          |

### Why condition output looks unformatted

`trackConditionResult` (`WorkflowExecutor.ts:1549`) flattens the whole
`EvaluationResult` into one prose string —
`` `${label} ${resultStatus}${actionSuffix} - Output:\n${output}` `` — where
`output` comes from `formatConditionOutput` (`:1528`), which glues stdout and
stderr together with `stdout:` / `stderr:` labels. That string is handed to
`trackStatusMessage` (`:1483`) and lands as a `status` row.

The `status` row renders through `StatusMessage.tsx`, whose container is
`flex items-center` with no `whitespace-pre-wrap` (`StatusMessage.tsx:47-57`).
Embedded newlines therefore collapse into a single wrapped line, and the row's
`estimateSize` is hardcoded at 36px (`outputRows.ts:1232`), so the virtualizer
mis-measures long dumps. That is the "removes formatting" symptom exactly.

Three further gaps fall out of the same split:

1. **No streaming.** `evaluateCondition` already accepts an `onOutput` callback
   (`EndConditionEvaluator.ts:158`) and the script-step path passes it
   (`WorkflowExecutor.ts:932`). The three condition call sites pass nothing, so
   a two-minute `npm test` gate shows nothing until it finishes.
2. **No verdict detail anywhere.** `EvaluationResult` carries `passed`, `stdout`,
   `stderr`, `exitCode`, `timeout`, `error`, `duration` — the executor then
   discards the comparison inputs. The user never sees which source was compared
   (`compareSource`), what was expected (`returns`), or what rule matched. Script
   steps show only an exit code (`outputRows.ts:1464`, `OutputRow.tsx:991`), and
   they have `compareSource`/`returns`/`onPass`/`onFail` too.
3. **Two renderers exist for the same data.** `components/output/CliOutput.tsx`
   still contains a full script-output branch (`CliOutput.tsx:1186-1304`), but
   the output pane has rendered through `buildOutputRows` + `OutputRow` for some
   time; `CliOutput` is now referenced only by the barrel export
   (`components/output/index.ts:1`) and its own test. Editing it changes nothing
   on screen.

## Goals

- **One pipeline.** Pre-conditions, end-conditions, end-condition retries, and
  script steps all emit the same `CliOutput` shape, stream live, and persist as
  CLI timeline entries so live view and history view are identical by
  construction.
- **A verdict block on every script execution**, showing compare source,
  expected, actual, the match rule that decided it, pass/fail/errored, and the
  action taken.
- **No second renderer.** Delete the orphaned `CliOutput.tsx` path rather than
  teaching it the new rows.

Non-goals: changing condition _semantics_ (`onPass`/`onFail` routing), running
conditions in a PTY, or the errored-vs-failed policy split (that is the On Error
plan).

## Target model

### One script execution, four sources

Add to `DashboardConstants.ts` next to `CONDITION_ACTIONS` (`:1068`) and
`COMPARE_SOURCES` (`:1078`):

```ts
export const SCRIPT_OUTPUT_SOURCES = {
  SCRIPT_STEP: "script", // keeps today's value — see migration note
  PRE_CONDITION: "preCondition",
  END_CONDITION: "endCondition",
} as const;
```

`CliOutput.source` (`WebviewMessageTypes.ts:193`) widens from
`typeof STEP_TYPES.SCRIPT` to `ScriptOutputSource`. Everything that currently
asks "is this a script?" goes through the existing `isScriptOutput` helper
(`utils/outputRenderUtils.ts`), which becomes `source != null` — so the plain
stdout rendering, `rawTextOutput: true`, and the exit-code stat all light up for
conditions with no per-call-site branching.

Keeping `SCRIPT_STEP` as the literal `"script"` means already-written
`events.jsonl` files keep rendering. Pre-release means we _may_ rename it, but
there is no reason to.

### `ScriptVerdict` — the new payload

New type in `CtrlYokeTypes.ts` beside `ScriptRuntimeOutput` (`:466`), carried on
`CliOutput` as `scriptVerdict?: ScriptVerdict`:

```ts
export interface ScriptVerdict {
  compareSource: CompareSource; // resolved, never undefined
  expected?: string; // condition.returns; absent = "exit code 0"
  actual: string; // the compared text (stdout/stderr/exit code)
  actualSource: "stdout" | "stderr" | "exitCode";
  exitCode?: number;
  outcome: "passed" | "failed" | "errored";
  matchRule: ScriptMatchRule; // why it passed/failed
  action: ConditionAction; // continue | stopWorkflow | retry | skipPrompt
  actionDetail?: string; // "retry 2 of 3", "skipped prompt"
  durationMs: number;
  timedOut?: boolean;
  error?: string; // evaluator/spawn error text
}

export type ScriptMatchRule =
  | "exitCode" // compareSource exitCode, or returns absent
  | "exact" // actual === expected
  | "boolean" // true/false/yes/pass synonyms (incl. exit-code fallback)
  | "numericGte" // parseFloat(actual) >= parseFloat(expected)
  | "substring" // actual.includes(expected)
  | "none"; // nothing matched, or the script never ran
```

`matchRule` is the piece that makes the block trustworthy. `checkResult`
(`EndConditionEvaluator.ts:672`) passes on `expected 80 / actual 92` via
numeric `>=` and on `expected "ok" / actual "all ok here"` via substring — shown
without the rule, a reader assumes a bug.

### Evaluator returns structure, not a boolean

`evaluateSuccess` (`:601`) and `checkResult` (`:660`) currently return `boolean`.
They return `{ passed: boolean; matchRule: ScriptMatchRule; actual: string;
actualSource }` instead, and `EvaluationResult` (`:23`) gains those fields. No
behavior change — the branches already exist, they just stop being collapsed to
a bit.

> The static `evaluateExitCodeResult` this plan originally also named was
> deleted as dead code in `5dc5674e`; interactive PTY script steps now evaluate
> through the same path. Nothing to port.

Add `errored: boolean` derived today from `result.error || result.timeout ||
!ranAtAll`. This plan only _displays_ it; the On Error plan later routes it.

### One emitter for all four call sites

New `src/core/orchestration/ScriptExecutionReporter.ts` owning the whole
publish sequence that `executeScriptStep` (`WorkflowExecutor.ts:806-1002`)
performs inline today:

1. emit the streaming placeholder `CliOutput` (`dispatchDashboardOutput`) and
   `startStreamingExecutionOutput` with `attemptContext.kind`;
2. hand `evaluateCondition` an `onOutput` that fans out to
   `updateCliStreamingChunk` + `appendStreamingChunk`;
3. build the final `CliOutput` (response = ANSI-stripped stdout+stderr,
   `exitCode`, `elapsed`, `scriptVerdict`) and `finalizeAndPersistOutput`;
4. `recordScriptExecution` for the lossless stdout/stderr record;
5. emit **one short** status line (see below).

`executeScriptStep` becomes a caller of it, as do the pre-condition block, the
end-condition block, and end-condition retries. The reporter takes the
`ScriptOutputSource`, the resolved `ScriptProperties`, and a `phase` (below);
the callers keep owning queue/state-machine transitions, which are genuinely
different per site.

Two details the reporter must preserve, both currently easy to break:

- **Only script _steps_ feed prior context.** `cacheRuntimeOutput` /
  `storeFinalStepResponseText` (`WorkflowExecutor.ts:1003-1010`) must stay in
  `executeScriptStep`. A gate's stdout is not the step's response and must never
  be injected into a later prompt.
- **ANSI stripping should stop being a local regex.** `WorkflowExecutor.ts:980`
  inlines `/\x1B\[[0-9;]*[a-zA-Z]/g`; use `sanitizeTerminalOutput`
  (`src/utils/TerminalOutputSanitizer.ts`), already the webview's sanitizer.

### Attempt identity needs a phase

CLI entries are keyed by `(target, runIndex, attemptIndex)` in three places —
`OutputHistoryTimelineAdapter.getCliEntryKey` (`:284`),
`StreamingHistoryBuffer` (`:252`), and the webview's
`findMatchingCliEntryIndex` (`workflowStore.ts:398`). A pre-condition and its
prompt share all three, so publishing a condition as a CLI output would
overwrite the prompt's own output.

Add a fourth component, `phase`:

```ts
export const EXECUTION_PHASES = {
  PROMPT: "prompt", // default; omitted in keys for stability
  PRE_CONDITION: "preCondition",
  END_CONDITION: "endCondition",
} as const;
```

- `OrderedCliHistoryEntry` gains `phase?: ExecutionPhase` (absent = `prompt`).
- All three key builders append `:phase:<p>` only when the phase is not
  `prompt`, so existing runs keep their exact keys.
- `TIMELINE_ATTEMPT_KINDS` (`WorkflowTimelineTypes.ts:62`) gains `CONDITION`,
  so a condition attempt is distinguishable from an AI or script-step attempt.

End-condition retries need no extra dimension: retry _N_ already increments
`attemptIndex`, and `(target, run, attempt N, endCondition)` is unique.

### Streaming chunks must be phase-keyed too

`updateCliStreamingChunk(stepIndex, chunk)` (`IDashboardSink.ts:98`) accumulates
into `streamingChunks[stepIndex]` (`workflowStore.ts:617`), and
`buildOutputRows` reads it back per target (`outputRows.ts:1341`). An
end-condition streaming into the same numeric slot would inherit the AI
attempt's leftover text.

Re-key the live chunk store by `(target, phase)`. This touches
`workflowStore.streamingChunks` / `finalStepStreamingChunks`,
`getStreamingChunk`, `BuildOutputRowsInput`, and the sink signatures.

> Cheaper fallback if that refactor is deferred: reset the slot
> (`updateCliStreamingChunk(idx, "")`) before each condition stream. It works
> today only because a condition never overlaps its own step's prompt streaming
> — an accidental invariant, not a designed one. Prefer the real key.

### Status messages shrink to one line

Conditions keep a status row, because the timeline ordering is what puts them
before/after the prompt in the pane — but it becomes a summary with no output
dump:

```
Pre-condition passed (exit code 0) → continue
End condition failed (stdout ≠ "PASS") → retry 1 of 3
```

`formatConditionOutput` (`:1528`) is deleted; `trackConditionResult` (`:1549`)
becomes a thin `formatVerdictSummary(verdict)` caller. The detail now lives in
the CLI output group directly above it.

While in here, fix a bug this design surfaced: the retry evaluation at
`EndConditionHandler.ts:407` calls `evaluateCondition(prompt.endCondition!,
retryContext.workspaceFolderPath)` with **no `vars`**, so `CTRLYOKE_VAR_*`
injection silently disappears on every retry evaluation while the initial
evaluation (`WorkflowExecutor.ts:1720-1724`) has it. Thread `vars` through
`RetryContext`.

## UI: the verdict block

New row kind `script-verdict`, appended to a script-ish output group between the
response and stats rows. Rendered by a new
`components/output/ScriptVerdict.tsx`.

Collapsed (default) — one line, colour-coded by outcome:

```
✔ Passed · exitCode · expected 0 · actual 0 · continue · 1.2s
✖ Failed · stdout ~ "PASS" · actual "3 tests failed" · retry 1 of 3 · 12.4s
⚠ Errored · spawn npm ENOENT · stopWorkflow · 0.1s
```

Expanded — a label/value grid:

| Row        | Value                                                          |
| ---------- | -------------------------------------------------------------- |
| Compare    | `exitCode` \| `stdout` \| `stderr` \| `auto → stdout`          |
| Expected   | `returns`, or _“exit code 0 (no `returns` set)”_               |
| Actual     | compared text, truncated via `buildCollapsedOutputPreview`     |
| Matched by | exact / boolean / numeric ≥ / substring / exit code / no match |
| Result     | Passed / Failed / Errored (+ timeout note)                     |
| Action     | `continue` / `skipPrompt` / `stopWorkflow` / `retry N of M`    |

`auto` must display as `auto → stdout` (or `→ exit code` for boolean `returns`),
because `evaluateSuccess`'s AUTO branch (`:648`) picks the axis at runtime and
"auto" alone tells the user nothing about what was actually compared.

Reuse `outputTruncation`'s `buildCollapsedOutputPreview` for long `actual`
values; expansion state follows the `BashOutput`/tool-call pattern (state in the
rows model, not in the component).

### Webview touchpoints for a new row kind

| File                                             | Change                                                                              |
| ------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `utils/outputRows.ts`                            | `ScriptVerdictRow` type, builder push, `estimateSize` case (`:1072`)                |
| `components/output/OutputRow.tsx`                | new `case "script-verdict"` in the switch (`:1209`)                                 |
| `components/output/ScriptVerdict.tsx`            | new component                                                                       |
| `utils/outputFind.ts`                            | search segments (`:137`) — expected/actual/action are searchable                    |
| `output-section/OutputScrollSeekPlaceholder.tsx` | label (`:20`); leave `shouldRenderScrollSeekPlaceholder` false — the block is small |
| `hooks/useOutputRowsModel.ts`                    | verdict expansion state, if expandable                                              |

`OutputPane.tsx` itself needs **no change**: it renders whatever rows the model
produces.

The header row for a condition group reuses `cli-header` with a distinct icon
(`codicon-shield` / `codicon-checklist`) and a label from `source` —
`Pre-condition`, `End condition`, `End condition retry 2` — driven off
`isScriptOutput` plus the new source, in `CliHeaderRowView` (`OutputRow.tsx:811`).

## Phasing

**Phase 0 — delete the dead renderer.** Remove `components/output/CliOutput.tsx`,
its barrel export (`components/output/index.ts:1`), and
`test/components/output/CliOutput.test.tsx`; port any assertions worth keeping
onto `OutputRow`/`buildOutputRows` tests. Do this first so nothing new is
written twice.

**Phase 1 — contracts.** `SCRIPT_OUTPUT_SOURCES`, `EXECUTION_PHASES`,
`ScriptVerdict`, `ScriptMatchRule`, `CliOutput.source`/`scriptVerdict`,
`OrderedCliHistoryEntry.phase`, `TIMELINE_ATTEMPT_KINDS.CONDITION`, and the
three key builders. No behavior yet; typecheck is the gate.

**Phase 2 — evaluator.** Structured `evaluateSuccess`/`checkResult`,
`EvaluationResult` extension, `errored`. Pure unit
tests (`src/test/endConditionEvaluator.test.ts` already covers the matching
matrix — extend the assertions to `matchRule`).

**Phase 3 — reporter.** Extract `ScriptExecutionReporter`, refactor
`executeScriptStep` onto it (behavior-identical, verdict added), then move the
pre-condition, end-condition, and retry sites onto it. Shrink the status lines.
Fix the missing `vars` on retry evaluation.

**Phase 4 — webview.** Phase-keyed streaming chunks, `script-verdict` row +
component, condition header labels, find/scroll-seek/estimate wiring.

**Phase 5 — tests.** See below.

Phases 1–3 are shippable without 4: conditions immediately stream and render as
proper script output groups; the verdict simply isn't drawn yet.

## Testing

Extension host (`src/test/**`):

- `endConditionEvaluator.test.ts` — `matchRule`/`actualSource` for each of the
  four compare sources and each match strategy, including `auto` resolving to
  exit code for boolean `returns` and to stdout otherwise.
- New `scriptExecutionReporter.test.ts` — one script execution emits placeholder
  → chunks → final output with verdict, in that order, for each of the four
  sources; a condition never writes `cacheRuntimeOutput`.
- `preConditionFlow.integration.test.ts` (existing) — assert the pre-condition
  now produces a CLI entry with `phase: "preCondition"` and that the prompt's own
  entry is untouched (the collision this design exists to prevent).
- Timeline adapter — two entries with the same `(target, run, attempt)` and
  different `phase` both survive `getCliEntryKey` dedupe.

Webview (`src/ui/webview-react/test/**`):

- `outputRows.test.ts` — a condition message produces
  header/command/response/verdict/stats rows; verdict `estimateSize` is
  non-trivial; streaming chunk for phase A does not leak into phase B.
- `OutputRow` render tests for each verdict outcome, including `auto → stdout`
  and the truncated-actual path.
- `outputFind` — expected/actual are searchable and highlight in place.

## Relationship to the On Error plan

`ON_ERROR_REDESIGN_PLAN.md` splits condition outcomes into
passed / failed / **errored** and gives `errored` its own policy
(`errorBehavior.onError`). This plan is the display half of the same
distinction and should land first or alongside: `ScriptVerdict.outcome` already
has the three-way shape, so the On Error work only has to populate `action` from
the new policy instead of from `onPass`/`onFail`. Neither plan blocks the other,
but implementing `errored` display twice would be waste — whoever gets there
first owns the enum.

## Risks

- **Virtualization drift.** Every new row kind needs a believable
  `estimateSize`; a verdict block that measures 3× its estimate causes scroll
  jump. Keep it a fixed-height collapsed line by default.
- **Status/CLI duplication.** If the one-line status summary is not trimmed at
  the same time the CLI output lands, every condition renders twice.
- **Key stability.** Omitting `:phase:prompt` from keys is what keeps existing
  `events.jsonl` and live/persist overlay matching working
  (`overlayLiveHistoryEntries`, `workflowStore.ts:411`). Do not "normalize" it to
  always include the phase.
- **Retry volume.** A gate that streams megabytes on every retry now persists
  that per attempt. `StreamingHistoryBuffer` already batches, but a
  `maxCapturedOutput`-style cap for condition scripts may be wanted later.
