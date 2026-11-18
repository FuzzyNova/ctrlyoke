# `onError: retry` re-sends only the retry prompt when a retry-prompt send fails

- **Found:** 2026-11-13 by the bug-hunt workflow final step (claude-cli), reviewing a1f660730
- **Area:** `src/core/WorkflowExecutor.ts` (`createSendRetryPromptCallback`)
- **Resolution:** fixed in this commit

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

Decide which is intended:

- Under `retry`, return a disposition from the callback so the outer step loop
  performs the documented whole-step retry (pre-condition, original prompt,
  fresh session). Under `retryPhase`, re-send the retry prompt, preferably
  resuming the session so the model keeps the task context.
- Or document this case as an exception in the schema description and the
  error-handling table, and reconsider sending the retry prompt in a fresh
  session.
