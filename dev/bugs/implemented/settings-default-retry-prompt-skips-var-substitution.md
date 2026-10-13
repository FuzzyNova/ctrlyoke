# Settings-default retry prompts are sent without `{{var}}` substitution, and the preview undercounts pass-retry steps

- **Found:** 2026-10-10 by claude-cli bug-hunt final step (review of ~b24cb32ab)
- **Area:** `src/core/WorkflowExecutor.ts` (`createSendRetryPromptCallback`, `resolveRetryPromptFile`), `src/core/EndConditionHandler.ts`, `src/core/ExecutionPreviewService.ts` (`buildConditions`), `src/core/RetryBudget.ts`
- **Resolution:** fixed in this commit

## Symptom

Two regressions from the fix for
`dev/bugs/implemented/retry-prompts-substitute-workflow-vars-twice.md` and
`dev/bugs/implemented/preview-retry-attempts-disagree-with-runtime.md`:

1. **Settings-default retry prompts keep literal `{{var}}` text.** Workflow
   `vars: { target: "src/foo.ts" }`, a step whose end condition has
   `maxRetries: 2` and no `retryPrompt`, and the setting
   `defaults.endCondition.retryPrompt: "Fix {{target}}"`. On a failed end
   condition the harness receives the literal `Fix {{target}}`. Before
   ~b24cb32ab it received `Fix src/foo.ts`. The same applies to a
   settings-default `passRetryPrompt`. No unresolved-variable warning fires,
   because `target` is a defined var.
2. **The preview undercounts pass-retry steps.** `{ onPass: retry, maxRetries: 3 }`
   previews "Maximum attempts: 1", but the runtime (`PromptQueue.canPassRetry`)
   re-runs the step up to 3 times after a pass, so 4 attempts. `{ onPass: retry }`
   alone previews 1 instead of `DEFAULT_ERROR_BEHAVIOR_RETRIES + 1`.

## Steps to Reproduce

1. Set `defaults.endCondition.retryPrompt` to a template containing a workflow
   var, define that var in the workflow, give a step `maxRetries: 2` and an end
   condition that fails.
2. Inspect the retry prompt in `events.jsonl`: `{{target}}` is literal.
3. Build the execution preview for a step with `{ onPass: retry, maxRetries: 3 }`:
   `conditions.retry.maxAttempts` is 1.

## Root Cause

1. Authored `retryPrompt`/`passRetryPrompt` are pre-substituted by
   `VarSubstitutor.applyToEndCondition`, so the fix made the retry callback
   skip var substitution for non-file text (`resolvePromptFileTextWithVariables`
   in `src/core/PromptTextResolver.ts` returns non-file text unchanged).
   But when a step has no authored template, `resolveRetryBudget` falls back to
   the raw settings default (`ConfigurationUtils.getDefaultRetryPrompt()` /
   `getDefaultPassRetryPrompt()`), which was never pre-substituted. It now
   reaches the harness unsubstituted.
2. `ExecutionPreviewService.buildConditions` uses
   `resolveRetryBudget(...).permittedRetries`, which counts only _failure_
   retries (`canRetry`). Pass retries share the same counter and only need
   `maxRetries` (`canPassRetry`), so an `onPass: retry` step with no
   `retryPrompt` and `onFail` not `retry` previews zero retries.

## Suggested Fix

1. Track where the retry text came from. Have `EndConditionHandler` tell the
   callback whether the text is an authored template (file resolution only,
   already substituted), a settings default (full
   `resolvePromptTextWithVariables` once), or literal text (the step's own
   resolved text, or the built-in fallback that embeds script output — no
   substitution). A small typed source enum in `RetryBudget.ts` (or returning
   the source from `resolveRetryBudget`) keeps this single-sourced; replace the
   `promptAlreadyResolved` boolean with it.
2. Expose the attempt budget from `RetryBudget` — e.g. a
   `previewRetries` / `anyRetries` value that is `maxRetries` when
   `canRetry || endCondition.onPass === CONDITION_ACTIONS.RETRY`, else 0 — and
   use it in `buildConditions`.

Tests: an executor retry test with a settings-default `retryPrompt` containing
`{{var}}` (`src/test/unit/WorkflowExecutor.test.ts`), the existing
double-substitution test must keep passing, and `onPass: retry` rows in
`src/test/unit/ExecutionPreviewService.test.ts`.
