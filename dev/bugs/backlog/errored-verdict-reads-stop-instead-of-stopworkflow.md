# An errored condition that stops the run reads "→ stop" instead of "→ stopWorkflow"

- **Found:** 2026-11-12 by the bug-hunt workflow's final step (claude-cli subagent), from code reading
- **Area:** `src/core/WorkflowExecutor.ts` (`getErrorBehaviorDecision`, `errorRetryActionDetail`)
- **Severity:** low

## Symptom

0.7.0 made an errored condition's verdict name the retry that follows, "or the action
taken once retries run out". When the action is `stopWorkflow`, the verdict reads
`→ stop` in the dashboard and `Action: stopWorkflow (stop)` in the CLI, while a failed
condition with the same action reads `→ stopWorkflow`. `stop` is not a configurable
action name. This partly brings back
`dev/bugs/implemented/end-condition-verdict-shows-retry-when-none-scheduled.md`: a
detail that overrides the real action when no retry is scheduled.

## Steps to Reproduce

1. A prompt step with `endCondition: { script: "sleep 30", timeoutSec: 1 }` and no
   `errorBehavior` (or `onError: retry` with its retries spent).
2. Run it. The end condition's verdict row ends with `→ stop`; the CLI prints
   `Action: stopWorkflow (stop)`.

## Root Cause

`getErrorBehaviorDecision` (#selection:src/core/WorkflowExecutor.ts:493-505) sets
`actionText` to `WORKFLOW_EXECUTION_OUTCOMES.STOP` (`"stop"`) for `stopWorkflow`, and
`errorRetryActionDetail` (#selection:src/core/WorkflowExecutor.ts:4014-4025) returns
that `actionText` as the verdict's `actionDetail` for every errored result.
`ScriptVerdict.tsx` and the CLI show `actionDetail ?? action`.

## Suggested Fix

Return a detail from `errorRetryActionDetail` only when `canRetry` is true ("retry N of
M"); otherwise `undefined`, so the verdict shows the real action. Check whether the
`"could not run … → <actionText>"` status in `handleEvaluationError` should also use
the action name. Add a unit test: an errored end condition with no retries left has no
`actionDetail` and action `stopWorkflow`.
