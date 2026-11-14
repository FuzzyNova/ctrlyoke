# A step that recovers through `onError: retryPhase` reports its last attempt as failed

- **Found:** 2026-11-13 by the bug-hunt workflow final step (claude-cli), reviewing a1f660730
- **Area:** `src/core/WorkflowExecutor.ts` (`handleEvaluationError`, the `retryPhase` end-condition loop in the prompt-step path), `src/core/orchestration/RunOutputResolver.ts`
- **Severity:** medium

## Symptom

A prompt step's end condition errors once (for example, it times out) and
`errorBehavior: { onError: retryPhase, maxRetries: 1 }` re-runs only the
end-condition script, which then passes. The run and the step both end
`completed`, but the attempt projection reports:

```json
"attempts": 1,
"lastAttempt": { "terminalState": "failed", "reason": "timed out after 4004ms" }
```

So `ctrlyoke run --json` shows a `completed`, `success: true` step whose
`lastAttempt.terminalState` is `failed`. Every other reader of the attempt
projection sees the same. The same setup with `onError: retry` reports
`attempts: 2` and `terminalState: "completed"`.

## Steps to Reproduce

1. A prompt step with `endCondition: { script: <hangs on its first run only>, timeoutSec: 4 }`
   and `errorBehavior: { onError: retryPhase, maxRetries: 1 }`.
2. Run it (opencode-cli with `opencode/big-pickle`, `--headless --json`), or
   drive `WorkflowExecutor` with a mock harness in a unit test.
3. `steps[0].status` is `completed` while `steps[0].lastAttempt.terminalState`
   is `failed`.

## Root Cause

- `updateDashboardWithResponse` records `completed` for AI attempt 0 before
  the end condition runs.
- When the end condition errors, `handleEvaluationError`'s `canRetry` branch
  calls `runtime.failAttempt` and `recordAttemptTerminal(..., FAILED, reason)`
  for that same attempt 0.
- The `retryPhase` loop (`while (endDisposition.outcome === CONDITION_ACTIONS.RETRY && isPhaseRetryPolicy(...))`)
  then re-runs only the end-condition script under attempt 1. The projection
  skips condition attempts (`RunOutputResolver`, `ATTEMPT_STARTED` with
  `TIMELINE_ATTEMPT_KINDS.CONDITION` is `continue`d), so attempt 1 never shows
  up there. When the end condition passes, `EndConditionHandler` calls
  `runtime.completeAttempt` but writes no timeline terminal.
- The last terminal recorded for the only AI attempt therefore stays `failed`.

With `onError: retry`, each retry is a new AI attempt with its own
`completed` terminal, so this never happens.

## Suggested Fix

When the error is an end-condition error that will be retried by phase
(`retryPhase`), don't record a `FAILED` terminal over the AI attempt's
`completed` one. Alternatively, once the `retryPhase` loop ends in CONTINUE,
record a `COMPLETED` terminal for the attempt that produced the response.
Cover both a queue step and a `finalStep` (same loop), asserting the run
projection's `latestAttempt.terminalState === "completed"` and that
`onError: retry` and pre-condition/script-step `retryPhase` (which behave like
`retry`) are unchanged.
