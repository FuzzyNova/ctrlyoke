# End-condition verdicts show "retry 0 of 0" when no retry will happen

- **Found:** 2026-09-28 by lots-of-bug-fixes final step (Claude)
- **Area:** `src/core/WorkflowExecutor.ts`, `src/core/orchestration/ScriptExecutionReporter.ts`
- **Resolution:** fixed in this commit

## Symptom

A prompt step with `endCondition: { script: "exit 1" }` (default `onFail: stopWorkflow`, no
retries) fails and stops the workflow, but its verdict reads
`End condition failed (exit code == 0, got "1") → retry 0 of 0` in the dashboard verdict row and
status line, and the CLI prints `Action: stopWorkflow (retry 0 of 0)`. Expected: `→ stopWorkflow`.

The same wrong text appears for:

- `onFail: continue` (the workflow advances, but the verdict says retry);
- errored evaluations (timeout, unsupported script type), where the detail overrides the
  errored action;
- the final evaluation after a pass-retry or fail-retry budget is spent (it still reads
  "retry N of N" although the step advances or stops).

## Root Cause

`endConditionActionDetail` in `WorkflowExecutor.ts` (around lines 3775-3785) returns
`retry <count> of <max>` for every result that isn't a non-retry pass, regardless of `onFail`,
`errored` or the remaining budget. `ScriptExecutionReporter` (around lines 150 and 405-408),
`ScriptVerdict.tsx` (around line 79) and `outputRows.ts` (around line 1203) all display
`actionDetail ?? action`, so the detail replaces the real action.

## Suggested Fix

Return a detail only when a retry will actually be scheduled: the result is not errored, and
either `(passed && onPass === retry && canPassRetry)` or `(!passed && canRetry)` (use the same
`PromptQueue` predicates the handler uses so the two can't drift). Show the upcoming retry number
(current count + 1) so the first retry reads `retry 1 of 2`. Otherwise return `undefined` so the
real action is shown.

Regression tests (`WorkflowExecutor.test.ts` or `scriptExecutionReporter.test.ts`): no
`actionDetail` for a failing default condition, for `onFail: continue`, for an errored evaluation,
and after the budget is exhausted; `retry 1 of 2` before the first real retry.

If the fix for `end-condition-onfail-retry-without-retryprompt-never-retries.md` has already
landed, build on its `canRetry` rules.
