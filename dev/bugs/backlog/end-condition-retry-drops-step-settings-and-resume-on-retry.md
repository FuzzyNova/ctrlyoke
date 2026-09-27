# End-condition retries drop step settings and ignore `resumeSessionOnRetry: false`

- **Found:** 2026-09-27 by the long-running bug-fix workflow final step (claude-cli, helper agent)
- **Area:** `src/core/EndConditionHandler.ts` (retry step construction), `src/core/WorkflowExecutor.ts` (`createSendRetryPromptCallback`)
- **Severity:** high

## Symptom

When an end condition fails with `onFail: retry`, the retry is sent as a cut-down step:

- **Session:** every retry resumes the old session. The schema says `resumeSessionOnRetry`
  "Set to false to start a fresh session for each retry", and `resumeSession`'s own
  description repeats it.
- **Step settings:** step-level `additionalArgs`, `toolPermissions` and `errorBehavior` are
  gone on the retry. Custom tool permissions revert to the workflow/default level,
  which matters for security, since a restricted step can get wider permissions on its
  retry.
- **Harness failure during a retry:** the `errorBehavior` decision is thrown away. With a
  workflow-level `errorBehavior {onError: retry, maxRetries: 3}`, the status says
  "Retrying attempt 2/3", but nothing is re-sent and the step ends as `error`.

Reproduced by running the real `WorkflowExecutor`, `PromptQueue` and `EndConditionHandler`
under `npx tsx`, with `MockHarnessIntegration` and a stub evaluator (fail, then pass). The
step was:

```yaml
prompt: do it
resumeSession: false
additionalArgs: ["--foo"]
toolPermissions: { mode: custom, ... }
errorBehavior: { onError: retry, maxRetries: 3 }
endCondition: { onFail: retry, maxRetries: 1, retryPrompt: try again, resumeSessionOnRetry: false }
```

The sends the harness received:

```
SEND {"prompt":"do it","additionalArgs":["--foo"],"toolPermissions":{"mode":"custom",...},"errorBehavior":{"onError":"retry","maxRetries":3},"resumeSession":false}
SEND {"prompt":"try again","toolPermissions":null,"resumeSession":true}
```

## Steps to Reproduce

1. Create a prompt step with `additionalArgs` and/or custom `toolPermissions`, and an
   `endCondition` with `onFail: retry`, a `retryPrompt` and `resumeSessionOnRetry: false`,
   whose check fails the first time.
2. Run it. The retry turn resumes the previous session and is launched without the
   step's args/permissions (visible in the dry-run/command preview or the harness
   command log).

## Root Cause

1. `EndConditionHandler.ts:~434-440` builds the retry step with only
   `prompt`, `model`, `endCondition` and `resumeSession`. Everything else on the step is
   dropped.
2. `WorkflowExecutor.createSendRetryPromptCallback` (`~4177`) runs
   `PropertyResolver.resolve` on that cut-down step, so step-level properties can't
   resolve. At `~4311` it then passes
   `resolvedProperties: { ...resolvedProperties, resumeSession: true }`, overriding the
   `resumeSessionOnRetry` value the handler computed. The providers read
   `workflowContext.resolvedProperties.resumeSession` (e.g. `ClaudeCliProvider`,
   `CodexCliProvider`).
3. At `~4337`, when the retry send fails, the callback awaits
   `handlePromptSendFailure(...)`, ignores the disposition it returns and returns
   `null`, so an `errorBehavior` retry decision is never acted on.

## Suggested Fix

- Build the retry step from the original: `{ ...prompt, prompt: retryPromptText,
  resumeSession: prompt.endCondition?.resumeSessionOnRetry ?? true }`, stripping runtime
  and one-shot fields (`_runtime`, `sessionId`, `preCondition`, and anything else that
  must not re-run on a retry).
- In `createSendRetryPromptCallback`, use the resolved `resumeSession` from that step
  instead of hard-coding `true`.
- Honour the disposition returned by `handlePromptSendFailure` in the retry callback, the
  same way the main send path at `~2253` does.
- Tests at the executor level: `resumeSessionOnRetry: false` produces a fresh-session
  retry; `true`/omitted resumes; step `additionalArgs`/`toolPermissions` are present on
  the retry send; a harness failure during a retry with `errorBehavior` retry actually
  re-sends.
