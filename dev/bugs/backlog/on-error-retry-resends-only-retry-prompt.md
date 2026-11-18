# `onError: retry` re-sends only the retry prompt when a retry-prompt send fails

- **Found:** 2026-11-13 by the bug-hunt workflow final step (claude-cli), reviewing a1f660730
- **Area:** `src/core/WorkflowExecutor.ts` (`createSendRetryPromptCallback`)
- **Severity:** low

## Symptom

The schema now defines `errorBehavior.onError: retry` as "re-run the whole step
from its pre-condition, starting a fresh harness session", and the
"Prompt / harness" row of `docs/workflows/error-handling.md` says `retry`
"Runs the pre-condition again, then sends the prompt".

That doesn't hold when the harness errors while ctrlyoke sends an end-condition
retry prompt. With a pre-condition, `endCondition: { onFail: retry, maxRetries: 1 }`
that fails once, and `errorBehavior: { onError: retry, maxRetries: 1 }`, a
harness error on the retry-prompt send gives:

- the pre-condition runs once;
- sent prompts are `["step 1", <retry prompt>, <retry prompt>]`, with
  `resumeSession` `[true, true, false]`.

So only the retry prompt is re-sent, in a fresh session. The model gets "The
previous task validation failed…" without the original task or conversation.
That is `retryPhase`-style behavior under `retry`, and a fresh session makes it
worse than either documented option.

## Steps to Reproduce

Drive `WorkflowExecutor` with a mock harness that fails the second send, using
the configuration above, and record the prompts and their `resumeSession`.

## Root Cause

`createSendRetryPromptCallback` has its own error-retry loop that rebuilds the
retry prompt with fresh-session properties and re-sends it. That loop predates
retryPhase (from the fix in
`dev/bugs/implemented/end-condition-retry-drops-step-settings-and-resume-on-retry.md`).
The new `retry`/`retryPhase` definitions don't account for it.

## Suggested Fix

**Decided 2026-11-18 (Nathan): match the documented behavior.**

- Under `retry`, `createSendRetryPromptCallback` stops retrying on its own and returns a
  disposition (for example a typed "step error, retry whole step" result) so the outer
  step loop performs the documented whole-step retry: pre-condition, original prompt,
  fresh session, counted against `errorBehavior.maxRetries`.
- Under `retryPhase`, re-send the retry prompt, resuming the session so the model keeps
  the task context.
- Remove the callback's private error-retry loop once both paths go through the shared
  disposition, so there is one place that counts error retries.
- Tests: the reproduction above asserts the pre-condition runs twice and the prompts are
  `["step 1", <retry prompt>, "step 1"]` with `resumeSession` `[true, true, false]` under
  `retry`, and that `retryPhase` re-sends the retry prompt with `resumeSession: true`.
- If the end-condition retry count and the error retry count interact (a whole-step retry
  restarting `endCondition.maxRetries`), state the rule in the schema description and
  `docs/workflows/error-handling.md`. Record the change under **Changed** in `CHANGELOG.md`.
