# On Error Redesign — Generalized `errorBehavior`

Status: **Proposed (2026-07-22).** Design agreed with Nathan; implementation
is in progress. Interim mitigations already shipped: the direct-command shell
fix in `EndConditionEvaluator`, and a warning status message when a gate cannot
run. Implementation-sketch item 1 is complete: evaluator results now carry an
explicit `errored` discriminator, and the executor reads it instead of using a
heuristic.

## Origin incident

A workflow-level `preCondition` of `npm test` failed with `spawn npm ENOENT`
(pre-shell-fix), and because the evaluator only reports `passed: boolean`, the
executor routed the _evaluation error_ through the `onFail` branch as if the
condition had legitimately evaluated false. With `onFail: continue` the prompt
ran anyway, and nothing surfaced in the UI. Two distinct defects:

1. **"The gate errored" is conflated with "the gate failed".** A script that
   could not run at all is not a condition outcome; treating it as one silently
   applies the wrong policy.
2. **`errorBehavior` only governs harness failures** and the UI labels it
   "On Harness Error", so there is no user-controllable policy for internal
   errors in gates or script steps.

## Decided model

### Three outcomes per condition script

| Outcome     | Meaning                                        | Governed by                       |
| ----------- | ---------------------------------------------- | --------------------------------- |
| **passed**  | Script ran; condition evaluated true           | `onPass` (unchanged)              |
| **failed**  | Script ran; condition evaluated false          | `onFail` (unchanged)              |
| **errored** | Script could not run / evaluation itself broke | `errorBehavior.onError` (**new**) |

"Errored" covers: spawn failure (ENOENT), script timeout, unsupported script
type, security-rejected path, and evaluator exceptions. For prompts, the
existing harness `FAILURE_KINDS` (process exit, harness error, timeout) are
already routed to `errorBehavior` — that part only gains the label change.

### One policy, whole-step retry

`errorBehavior` becomes the single internal-error policy for **every phase of
a step**: pre-condition, prompt/harness, end-condition, and script steps. The
UI label changes from "On Harness Error" to "On Error". The schema needs no
rename — the field was always `errorBehavior`.

**`retry` always retries the whole step, from the pre-condition.** (Decision:
Nathan, 2026-07-22.) A step is `preCondition → prompt → endCondition`; the
gate is part of the step's contract, so a retried step must re-establish its
precondition — the gate may provision or verify state the prompt depends on,
and re-checking it before burning another AI call is what makes retry safe.
This is a **behavior change**: today's harness-failure retry loop wraps only
the send (`executeWithStreaming`), so the pre-condition is evaluated once and
never re-run on retry.

> Mechanical note: a pre-condition subprocess cannot literally export
> environment variables into the extension or harness process — its env dies
> with it. "Provisioning" means files/workspace/service state. Dynamic values
> flow _into_ scripts via `CTRLYOKE_VAR_*` env injection; never interpolate
> dynamic values into the script command string (see the shell-safety
> invariant in `core.instructions.md`).

### Action semantics

- **`stop`** (default, matching today's `{ onError: "stop" }` fallback): fail
  the step and stop the workflow. An un-runnable gate is a configuration error
  the user should see immediately.
- **`retry`**: re-enter the step from the top (pre-condition included), up to
  `maxRetries`, honoring `retryDelayMs`. **One retry budget per step**: gate
  errors, harness failures, and end-condition errors all draw from the same
  `attemptIndex`/`maxRetries` counter — otherwise multiple error sources
  multiply the budget.
- **`continue`**: proceed as if the phase had not errored (gate → run the
  prompt; end-condition → accept the response), but always emit the warning
  status message. This is the "best effort" mode and must never be silent.

### Carve-outs (explicitly unchanged)

- **`endCondition.onFail: "retry"` keeps its conversational semantics** —
  send `retryPrompt` into the same session (`resumeSessionOnRetry`). That is a
  _condition outcome_ action (the script ran; the AI's answer was wrong), not
  an internal error, and its value is precisely that it does NOT redo the whole
  step. The plan must not merge it into whole-step retry.
- **`onPass`/`onFail` option sets stay as they are.** No `retry` action is
  added to pre-condition outcomes; a legitimately failing gate that should be
  polled/retried is out of scope (workflow-scheduling territory).
- Consequence accepted for consistency: an errored _end_-condition under
  `retry` re-runs the whole step including a fresh AI call, even though the
  response being validated may have been fine. A future refinement could try
  one cheap re-evaluation of the script alone first; deliberately not in v1.

## Surfacing (the UI half of the incident)

- Every errored phase emits a status message under the step
  (`trackStatusMessage`, severity `warning` for `continue`/`retry`, `error`
  for `stop`), naming the phase and the error:
  `Pre-condition could not run: spawn npm ENOENT → continue`.
- `stop` additionally surfaces through the existing failure path (step marked
  failed, workflow `ERROR` state) so it is impossible to miss.
- `WorkflowPropertiesPanel` / `PropertiesDrawer`: label "On Harness Error" →
  "On Error"; help text updated to say it covers pre/end-conditions and script
  steps too.

## Implementation sketch

1. **`EndConditionEvaluator` returns an explicit discriminator (complete
   2026-07-25)** — add
   `errored: boolean` (or `outcome: "passed" | "failed" | "errored"`) to
   `EvaluationResult` instead of callers inferring from `error && !stderr`.
   The interim heuristic in `WorkflowExecutor` (status message added
   2026-07-22, `!preResult.passed && preResult.error && !preResult.stderr`)
   must be replaced by this field.
2. **Executor step pipeline refactor**: hoist the retry loop so it encloses
   the pre-condition gate, not just `executeWithStreaming`. The
   gate/prompt/end-condition sequence becomes one retryable unit sharing
   `attemptIndex`.
3. **Script steps**: route `errored` script-step evaluations through the same
   policy (their `onPass`/`onFail` — `continue`/`stopWorkflow` — stay outcome
   actions).
4. **Schema/docs**: `errorBehavior` description updated (workflow-schema.json
   - `CtrlYokeTypes.ts` JSDoc); no shape change (`onError`, `maxRetries`,
     `retryDelayMs` as today).
5. **UI**: label + help text; no new fields.

## Testing

- Extend `src/test/integration/preConditionFlow.integration.test.ts` (full
  execution harness already exists): errored gate with `onError: stop` halts
  before the prompt; `onError: retry` re-runs the gate (marker file written
  twice) then the prompt; `onError: continue` runs the prompt and emits the
  warning; retry budget shared with harness failures (mock `onSend` failure +
  errored gate must not exceed `maxRetries` combined).
- Unit: `EndConditionEvaluator` sets `errored` for ENOENT/timeout/unsupported
  type/security-rejected; never for a clean non-zero exit.
- `WorkflowExecutor` unit tests for the hoisted retry loop (existing
  `MockHarnessIntegration` covers the harness side).

## Open questions

- **Session semantics on whole-step retry**: should the retried prompt resume
  the prior attempt's session or start fresh? (endCondition's
  `resumeSessionOnRetry` answers this for conversational retry; whole-step
  retry needs its own default — leaning fresh-per-attempt, matching today's
  harness retry behavior.)
- Should `continue` on an errored _end_-condition mark the step visually
  distinct from a genuinely validated step (e.g. "completed (unvalidated)")?
