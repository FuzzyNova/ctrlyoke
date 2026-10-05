# End-condition retries use up the `errorBehavior` retry budget, and a re-sent retry's verdict is recorded on the failed attempt

- **Found:** 2026-10-01 by bug-hunt final step (claude-cli), reproduced by modifying an existing `WorkflowExecutor` unit test
- **Area:** `src/core/WorkflowExecutor.ts` (`canRetryErrorBehavior` ~419, retry-send loop ~4449-4545, `handleEvaluationError` ~3572), `src/core/EndConditionHandler.ts` (~363, ~418-467)
- **Resolution:** fixed in this commit

## Symptom

**1. Retry budget.** Take a step with `errorBehavior: { onError: retry }`
(default one retry, per the schema: "When omitted, one retry is allowed") and
`endCondition: { onFail: retry, maxRetries: 1, retryPrompt: "retry" }`. The
end condition fails once, then the harness errors while sending the retry
prompt. The workflow stops without ever using its error retry. The same
happens when the end-condition script itself errors (e.g. times out) on a later
end-condition retry: an error budget of 1 is already "used up" by the
end-condition retries.

**2. Attempt indices.** When `errorBehavior` does allow the re-send, the AI
response is recorded as attempt 2, but the end-condition re-evaluation is
recorded on attempt 1, the attempt whose send failed (`source:"endCondition"`,
`recordScriptExecution(...,1,...)`). The runtime then marks attempt 1
`completed`. If that verdict fails and another retry runs, it gets index
`1 + 1 = 2`, which was already used. The timeline shows the verdict on the
wrong attempt, and two attempts' history overlaps.

## Steps to Reproduce

- **Symptom 1:** copy `re-sends an end-condition retry after a retry harness
failure` (`src/test/unit/WorkflowExecutor.test.ts` ~761) and remove its
  `errorBehavior.maxRetries: 2`. The prompts sent become `["initial","retry"]`
  instead of `["initial","retry","retry"]`.
- **Symptom 2:** in the unmodified test, record the history calls. The
  end-condition evaluation after the re-send is attributed to attempt 1.

## Root Cause

- `canRetryErrorBehavior(errorBehavior, attemptIndex)` compares the step's
  overall `attemptIndex` with `errorBehavior.maxRetries`. End-condition retries
  also advance `attemptIndex`, so they count against the error budget.
- `SendRetryPromptCallback` advances `sendAttemptIndex` internally when an
  error re-send happens, but returns only the response text. `EndConditionHandler`
  keeps using its own `nextAttemptIndex` for evaluation, the returned
  `attemptIndex`, and the following retry.

## Suggested Fix

- Count `errorBehavior` retries separately from end-condition retries: track
  the number of error retries within the current phase or attempt chain, and
  pass that count, not the attempt index, to `canRetryErrorBehavior` at every
  caller.
- Have the retry-send callback return the attempt index it actually used.
  `EndConditionHandler` should evaluate, record, and continue from that index.
- Tests: the modified repro above sends `["initial","retry","retry"]`; an
  end-condition script timeout on end-condition retry 2 with default
  `errorBehavior` retry still gets its one error retry; after an error re-send,
  the end-condition evaluation and the terminal status are recorded on the
  re-sent attempt, and the next retry gets a fresh index.
