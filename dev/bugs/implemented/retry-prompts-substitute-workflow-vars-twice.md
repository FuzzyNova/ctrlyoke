# Workflow `{{vars}}` are substituted twice in retry prompts

- **Found:** 2026-10-10 by claude-cli bug-hunt final step (reproduced with a scratch `npx tsx` script)
- **Area:** `src/core/WorkflowExecutor.ts` (`createSendRetryPromptCallback`), `src/utils/VarSubstitutor.ts`, `src/core/EndConditionHandler.ts`
- **Resolution:** fixed in this commit

## Symptom

With `vars: { snippet: "Write {{name}} literally", name: "Bob" }` and a step
prompt `Task: {{snippet}}`:

- attempt 0 sends `Task: Write {{name}} literally` (single substitution, as
  intended),
- a pass retry (which falls back to the step's own text) sends
  `Task: Write Bob literally`.

A `retryPrompt`/`passRetryPrompt` containing a variable whose value contains
`{{…}}` gets the same second expansion. The prompt the model sees on a retry
differs from the original attempt.

## Steps to Reproduce

1. Define the vars above and an end condition that passes-retries (or fails
   with a `retryPrompt` that references `{{snippet}}`).
2. Compare the attempt-0 prompt with the retry prompt in `events.jsonl`.

## Root Cause

- `retryPrompt`/`passRetryPrompt` are already substituted by
  `VarSubstitutor.applyToEndCondition` (`src/utils/VarSubstitutor.ts` ~160).
- The pass-retry fallback text is `prompt.prompt`, which was already replaced
  by the resolved `effectivePromptText` (`WorkflowExecutor.ts` ~2238) and is
  returned by `EndConditionHandler` (~560).
- `createSendRetryPromptCallback` then runs `resolveEffectivePrompt` on that
  text again (`WorkflowExecutor.ts` ~4456-4462), substituting vars a second
  time.

## Suggested Fix

Resolve and substitute retry text exactly once. Either build retry text from
the raw (unsubstituted) step and end condition and resolve it once in the
callback, or skip var substitution in the callback for text that is already
resolved. Make sure prompt-file resolution still happens exactly once for a
retry prompt that names a file. Test in `src/test/unit/EndConditionHandler.test.ts`
or an executor retry test, asserting that the retry text equals a single
substitution.
