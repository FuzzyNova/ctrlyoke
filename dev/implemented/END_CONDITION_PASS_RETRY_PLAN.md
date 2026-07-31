# End-Condition Pass Retry (`onPass: retry`)

> **Last Updated:** July 29, 2026
> **Status:** Implemented — pass retries now re-run the step with a shared
> pass/fail budget, re-evaluate the end condition, and honor normal `onFail`
> handling when a pass-retry re-check fails.
> **Supersedes:** the "removed until orchestrator loop support exists" version of
> this document. Commit `d9d3e688` stripped `retry` from `endCondition.onPass`
> instead of implementing it. That decision is **reversed**: the option has been
> implemented for real.

## Why this feature exists

Two independent reasons:

1. **Parity.** `onFail: retry` re-prompts the harness while a condition keeps
   failing. There is no reason the passing direction cannot do the same, and the
   schema advertised it for a long time, so users already expect it.
2. **"Loop until the condition fails" workflows.** The motivating case is a
   test-first / regression workflow whose first step must produce a test that
   **fails** (reproducing the bug). The whole rest of the workflow depends on
   that. Expressed with end conditions:

   ```yaml
   steps:
     - prompt: Write a regression test that reproduces issue #123. Do not fix the bug.
       endCondition:
         script: npm test
         returns: "true" # "the suite is green" — which here means the test did NOT reproduce
         onPass: retry # green means the repro failed; ask again
         onFail: continue # red means we have a genuine failing repro; move on
         maxRetries: 3
         passRetryPrompt: |
           `npm test` still passes, so the new test does not reproduce the bug yet.
           Strengthen the test until it fails for the right reason.
   ```

   `onPass: retry` + `onFail: continue` is the composition that expresses
   "keep going while the condition holds, advance once it breaks."

3. The original schema use case is also restored: **"keep implementing backlog
   items while tests stay green"** — `onPass: retry` with `maxRetries: -1` or a
   fixed ceiling, re-sending the step's own prompt.

## Semantics (the contract to implement)

Given an `endCondition` whose evaluation **passes**:

| `onPass`       | Behavior                                                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `continue`     | (default) complete the attempt, advance the queue. Unchanged.                                                                                           |
| `stopWorkflow` | fail the attempt with `End condition passed with onPass: stopWorkflow`. Unchanged.                                                                      |
| `retry`        | **new** — re-send a pass-retry prompt into the step's session, re-evaluate the end condition, and loop while it keeps passing and retry budget remains. |

Rules that define the loop:

1. **Exhausting the pass-retry budget while still passing is success, not
   failure.** The handler logs it, completes the attempt, and returns
   `shouldContinue: true`. There is **no** `handleMaxRetriesExhausted` dialog on
   the pass side — that dialog ("Stop Workflow / Continue Anyway / Retry Once
   More") stays exclusive to validation failure. Prompting a user because a
   condition kept succeeding would be nonsense.
2. **If a re-evaluation inside the pass-retry loop fails, normal `onFail`
   handling applies to that evaluation** — including `onFail: retry` with its
   own exhaustion dialog, `onFail: continue` (advance), and
   `onFail: stopWorkflow`. This is what makes the regression-test recipe work.
3. **Opt-in gate.** Pass retries happen only when `onPass === "retry"`.
   Do **not** copy the failure side's looser gate. (Existing quirk, preserve it:
   the failure path retries whenever `retryPrompt`/`maxRetries` permit, even when
   `onFail` is `stopWorkflow`; existing tests cover that and it must not change.)
4. **One shared retry budget per step.** `maxRetries` caps the _total_ number of
   re-prompts for the step across both directions, using the existing
   `PromptQueue.currentRetryCount`. Do not add a second counter.
   - Rationale: with `onPass: retry` a pass is no longer a terminal success, so
     the current `resetRetryCount()`-on-pass would refill the budget every time
     the condition flipped and an alternating pass/fail sequence would loop
     forever. A single budget that is reset only when the step actually
     terminates (advance / skip / fail) makes the worst case provably bounded at
     `maxRetries` re-prompts per step. That bound is the safety property that
     matters, since every retry is a paid harness call.
   - Consequence to implement carefully: `resetRetryCount()` must **not** run on
     a pass that is about to pass-retry; it still runs on every path that
     advances or terminates the step.
5. **`maxRetries` default.** When `onPass: retry` is set and `maxRetries` is
   unset, default to `1` — mirroring the existing rule for `onFail: retry` in
   `handleEndConditionResult`. `-1` means unlimited (explicit user choice,
   bounded in practice by `maxWorkflowExecutionTime` and manual stop).
6. **Stop/pause honored.** Check `retryContext.runtime.stopped` before sending
   each pass-retry prompt and again after the response, exactly as the failure
   loop does.
7. **Session continuity.** Pass retries reuse `resumeSessionOnRetry`
   (default `true`), same as failure retries.
8. **Attempt bookkeeping is identical for both directions**: allocate the next
   `attemptIndex`, call `runtime.scheduleRetry(...)`, and go through the
   executor's `SendRetryPromptCallback` so timeline/history
   (`recordRetryScheduled`) and dashboard output stay correct. No new timeline
   event type is needed — `RETRY_SCHEDULED` already carries the prompt text and
   is direction-neutral.
9. **Final steps too.** The same handler serves `attemptTarget.kind` `queue` and
   `finalStep`; pass retries must work for both.
10. **Out of scope, unchanged:** `preCondition` (its action union has no
    `retry`), `scriptStep.onPass/onFail` (continue/stopWorkflow only), and
    evaluator-error policy (`errorBehavior`, owned by the executor).

## New field: `endCondition.passRetryPrompt`

A pass retry cannot reuse `retryPrompt`. That template is failure-shaped
("validation failed … please fix the issues"), and the default one from settings
is too; sending it after a _passing_ condition tells the harness the opposite of
the truth. So:

- Add optional `passRetryPrompt?: string` to `EndCondition`, supporting the same
  placeholders as `retryPrompt` (`{stdout}`, `{stderr}`, `{exitCode}`,
  `{actual}`, `{expected}`, `{compareSource}`) via the existing
  `EndConditionEvaluator.buildRetryPrompt(...)`.
- Resolution order for the text actually sent:
  1. `endCondition.passRetryPrompt`
  2. `ctrlyoke.defaults.endCondition.passRetryPrompt` (settings)
  3. **the step's own `prompt` text, re-sent verbatim**
- Because option 3 always exists, `onPass: retry` needs no extra configuration
  to be useful — bare `onPass: retry` means "run this prompt again while the
  condition holds", which is exactly the backlog-loop use case. Note this makes
  the pass-side gate `onPass === "retry" && budget remains`; unlike the failure
  side, absence of a template must **not** disable pass retries.
- `retryPrompt` stays failure-only. Never send it on a pass.

## Current-state notes for implementers

- The strip commit left three **live inconsistencies** that this work resolves:
  - `ScriptConditionEditor.tsx` still offers "Retry" in the On Pass dropdown
    (`END_CONDITION_ACTION_OPTIONS` is shared by both selects), so the dashboard
    can author a workflow that `PromptFileParser` then rejects.
  - `schemas/settings-schema.json` still allows `retry` in the default end
    condition's `onPass` enum while `schemas/workflow-schema.json` does not.
  - `ValidationUtils` rejects it, so those authored workflows fail to load.
- `schemas/workflow-schema.yaml` is **generated** from
  `schemas/workflow-schema.json` by `npm run generate-schema`. Never hand-edit
  the YAML.
- `EndConditionPassAction` (`src/types/CtrlYokeTypes.ts:582`) exists only to
  exclude `retry` from `onPass`. It is deleted by this work; `onPass` returns to
  `EndConditionAction`. Two files reference it (`EndConditionHandler.ts`,
  `src/test/unit/EndConditionHandler.test.ts`).
- `ScriptExecutionReporter.createVerdict` already forwards `request.onPass` into
  `verdict.action`, so a passing verdict will display `retry` with no change.
  Its `actionDetail` callback in `WorkflowExecutor` currently emits the
  `retry N of M` detail only for non-passing results and needs the passing case.
- `EndConditionHandler` must stay iterative and callback-based (no executor
  imports) per `core.instructions.md`.

## Plan

Gate for **every** step: `npm run typecheck`, `npm run lint`, and `npm test`.
**Never run `npm run test:harness`** — it makes real paid API calls.
Each step commits its own work (conventional commit, no attribution trailers)
and updates the Progress Log at the bottom of this file.

Ordering rationale: the engine lands **before** the schema opens the option up,
so there is never a commit where `onPass: retry` parses but silently behaves as
`continue` (the exact defect the audit was removing).

### Step 1 — types + engine

- `src/types/CtrlYokeTypes.ts`: delete `EndConditionPassAction`, set
  `onPass?: EndConditionAction`, add `passRetryPrompt?: string`, refresh the
  `maxRetries` doc comment to say the budget is shared across both directions.
- `src/core/PromptQueue.ts`: extend `RetrySettings`/`resolveRetrySettings` with
  `passRetryPrompt` (explicit → settings default), add
  `getEffectivePassRetryPrompt(prompt)` and a `canPassRetry(prompt)` gate that
  does **not** require a template. Add
  `ConfigurationUtils.getDefaultPassRetryPrompt()`.
- `src/core/EndConditionHandler.ts`: restructure into one iterative loop that
  serves both directions and shares a single private "send retry prompt →
  re-evaluate" helper (DRY — do not fork a second near-duplicate loop next to
  `handleValidationFailureIterative`). Add `buildPassRetryPrompt`. Pass-retry
  dashboard status message should read as a re-run, e.g.
  `Re-running Prompt N (Pass retry X/Y)`, not "Retrying".
- Unit tests in `src/test/unit/EndConditionHandler.test.ts` and
  `src/test/promptQueue.test.ts` covering: pass-retry loop that keeps passing
  until the budget is exhausted then advances; pass-retry then failure with
  `onFail: continue` (the regression-test recipe); `onFail: stopWorkflow` after a
  pass retry; stop requested mid-loop; `maxRetries` defaulting to 1; the shared
  budget bound across mixed pass/fail sequences; template resolution including
  the fall back to the step's own prompt; placeholders substituted; and
  regression coverage that the pure-failure path is untouched.

### Step 2 — schema, validation, completions

- `schemas/workflow-schema.json`: restore `retry` to `endCondition.onPass`, and
  document the semantics above (including "exhausting pass retries advances").
  Add `passRetryPrompt`. Regenerate with `npm run generate-schema`.
- `schemas/settings-schema.json`: add `passRetryPrompt` to the defaults
  `endCondition` object.
- `src/utils/ValidationUtils.ts`: add `retry` to the `onPass` enum and
  `passRetryPrompt` to both endCondition schema blocks, plus the manual string
  check alongside `retryPrompt`'s.
- `src/core/WorkflowStepSanitizer.ts` (`cloneEndCondition`) and
  `src/utils/VarSubstitutor.ts` (`applyToEndCondition`): carry
  `passRetryPrompt`.
- `src/completions/PromptPropertyCompletionProvider.ts`: restore `retry` in the
  `onPass` prose.
- Invert the two tests the strip commit added — `promptFileParser.test.ts`
  "should reject onPass retry" and `validationUtils.test.ts` "should reject retry
  as an end-condition onPass action" — into acceptance tests, and add
  sanitizer/var-substitution coverage for `passRetryPrompt`.

### Step 3 — executor + reporter observability

- `src/core/WorkflowExecutor.ts`: emit the `retry N of M` `actionDetail` for
  passing verdicts when `onPass: retry` is active, keeping the failure detail
  as-is.
- Add an executor-level test (`src/test/integration/` or
  `src/test/unit/WorkflowExecutor*`) proving a pass-retry round trip: prompt →
  passing end condition → pass-retry prompt sent → re-evaluation → advance, with
  the retry recorded in history.

### Step 4 — dashboard UI + docs

- `src/ui/webview-react/components/shared/ScriptConditionEditor.tsx`: add a
  "Pass Retry Prompt" CodeMirror field, shown when `onPass === retry`; show
  "Retry Prompt" when `onFail === retry`; keep Max Retries visible when either is
  retry. Add `passRetryPrompt` to `ScriptConditionValue`.
- Thread the field through the webview/message plumbing that already enumerates
  `retryPrompt`: `src/types/WebviewMessageTypes.ts`,
  `src/ui/webview-react/store/editorStore.ts`,
  `src/ui/webview-react/store/settingsStore.ts`,
  `src/ui/webview-react/utils/prompt.ts`, and
  `src/ui/webview-react/utils/stepClipboard.ts` where applicable. The defaults
  page (`components/settings/defaults/DefaultsValidationPage.tsx`) renders
  `ScriptConditionEditor`, so it inherits the new field.
- Vitest updates in
  `src/ui/webview-react/test/components/shared/ScriptConditionEditor.test.tsx`.
- Docs: `docs/reference/workflow-schema.md` (restore `retry` in the `onPass` row,
  add `passRetryPrompt`), `docs/workflows/end-conditions.md` (document the loop
  plus the regression-test recipe), and
  `src/templates/agents/ctrlyoke-workflow-composer.agent.md` so the authoring
  agent knows the option exists. Update the README settings table if the new
  default is user-facing.

### Step 5 — close-out

- Add a `manual-test/` workflow fixture exercising `onPass: retry` (follow the
  existing `manual-test/retry-*.ctrlyoke.json` conventions).
- Reconcile `dev/backlog/DEAD_METHOD_AND_INCOMPLETE_FEATURE_AUDIT.md`: Sweep 2
  item 1 and Phase 4 currently record the removal as the resolution. Rewrite both
  to state that the removal was reversed and the feature implemented, with a
  pointer here.
- Full gate: `npm run typecheck`, `npm run lint`, `npm test`. Flip this
  document's status to Implemented.

## Progress Log

<!-- Each step appends one line: step number, date, what landed. -->

- Plan written 2026-07-29 (orchestrator); steps 1–5 queued.
- Step 1 implemented 2026-07-29: restored the shared engine-level pass-retry loop, pass-retry prompt resolution, and coverage for mixed pass/fail budgets; no deviations from the plan.
- Step 2 implemented 2026-07-29: reopened schemas, validation, completions, sanitizer/variable propagation, and authoring coverage for `onPass: retry` and `passRetryPrompt`; regenerated the YAML schema; all gates passed.
- Step 3 implemented 2026-07-30: wired passing end-condition retry details through both executor report paths and added reporter plus executor round-trip/history coverage; all gates passed.
- Step 4 implemented 2026-07-29: added pass-retry dashboard authoring and settings plumbing, updated UI coverage, and documented pass-retry behavior and authoring guidance; all gates passed.
- Step 5 implemented 2026-07-29: added the pass-retry manual fixture, reconciled the audit and scoped stale-claim sweep, and captured the shared retry-budget invariant. Typecheck, lint, and tests passed; format:check remains blocked by 30 pre-existing repository-wide formatting failures outside this close-out scope.
- Review pass 2026-07-29 (orchestrator): verified all five steps against the code. Three fixes applied — (1) Step 5's format:check claim was wrong: 8 of those 30 failures were regressions from this feature, so the feature's own files plus its docs were formatted (30 → 18 remaining, all pre-existing); (2) the manual fixture's "loop until the condition fails" step could never fail, because `check_counter.py` always exits 0 and `auto` mode resolves `returns: "true"` to the exit code — it now sets `compareSource: "stdout"`, with the reason recorded in `manual-test/README.md`; (3) restored the `EndConditionAction` doc comment to cover both directions. Gate re-run green: typecheck, lint, 2208 extension-host tests, 1237 webview tests. `dev/backlog/DEAD_METHOD_AND_INCOMPLETE_FEATURE_AUDIT.md` is deliberately left unformatted — its failure predates this feature and reformatting it is ~112 lines of unrelated churn.
