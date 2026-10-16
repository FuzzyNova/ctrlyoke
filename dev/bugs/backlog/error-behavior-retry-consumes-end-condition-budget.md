# An `errorBehavior` retry uses up the end condition's `maxRetries` budget

- **Found:** 2026-10-15 by bug-hunt final step (claude-cli)
- **Area:** `src/core/WorkflowExecutor.ts`, `src/core/WorkflowStateMachine.ts`, `src/core/PromptQueue.ts`
- **Severity:** high

## Symptom

A step with `errorBehavior: { onError: retry }` and
`endCondition: { onFail: retry, maxRetries: 1 }` gets one transient harness
failure; the error retry then succeeds. When the end condition fails, no
end-condition retry runs: the step stops with "End condition failed after 1
retries." The same happens after a pre-condition or end-condition script error
that `errorBehavior` retried. During an end-condition retry, a failed re-send
overwrites the end-condition counter: it can go lower (extra retries) or higher
(fewer).

This is the reverse of
`dev/bugs/implemented/end-condition-retries-consume-error-behavior-budget.md`.

## Steps to Reproduce

Driving the compiled state machine through the executor's sequence:
`beginAttempt(0)` → `failAttempt` → `scheduleRetry(target, 1, 1, 1)` →
`beginAttempt(1)`. After that, `getRetryCount(target)` is `1`, and
`PromptQueue.canRetry` with `maxRetries: 1, onFail: retry` is `false`, before any
end-condition retry has run.

## Root Cause

- `handleHarnessFailure` (`WorkflowExecutor.ts` ~5371) calls
  `runtime.scheduleRetry(target, nextAttemptIndex, errorRetryCount + 1, errorMaxRetries)`.
  `handleEvaluationError` (~3706) does the same for condition script errors.
- `WorkflowStateMachine.beginAttempt` (~155–175) carries `retryCount`/`maxRetries`
  over when the next attempt has the same index.
- `PromptQueue.canRetry`/`canPassRetry` (~1254–1290) read that same `retryCount`
  via `stateMachine.getRetryCount()` as the end condition's shared retry counter.

So one field holds two different budgets.

## Suggested Fix

Keep the counters apart. Either give `WorkflowAttemptState` a separate
`errorRetryCount` for `errorBehavior` retries, or have both error paths pass the
attempt's current end-condition `retryCount` (and its `maxRetries`) through to
`scheduleRetry` while tracking the error count only in the executor. Add executor
tests:

- One harness error, then an end-condition failure with `maxRetries: 1`: the
  prompts sent are `initial, initial, retry`.
- The same with a condition-script error in place of the harness error.
