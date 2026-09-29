# End condition `onFail: retry` without a `retryPrompt` never retries, contradicting the schema and troubleshooting docs

- **Found:** 2026-09-28 by lots-of-bug-fixes final step (Claude)
- **Area:** `src/core/PromptQueue.ts`, `src/core/EndConditionHandler.ts`
- **Resolution:** fixed in this commit

## Symptom

`endCondition: { script: npm test, onFail: retry }` (with the default settings, where
`defaults.endCondition` is `null`) fails the step immediately with "End condition failed after 0
retries." No retry is sent. `onFail: retry, maxRetries: 3` also sends 0 retries.

That contradicts:
- the schema `description`s (`docs/reference/workflow-schema.md`, `maxRetries` around line 620:
  "When onPass or onFail is 'retry' and this field is omitted, one retry is allowed"; `onFail`
  around line 652: "'retry': re-run the AI prompt (up to maxRetries times)");
- `docs/troubleshooting/common-errors.md` (around line 72): "Set `onFail: retry` (with
  `maxRetries`, which defaults to `1`) to send the step back to the harness";
- the handler's own intent: `EndConditionHandler` (around lines 155-170) defaults `maxRetries` to 1
  when `onFail === retry`, and `buildRetryPrompt` (around line 540) has a built-in fallback prompt
  for when no template is configured, which `canRetry` makes unreachable.

`docs/workflows/end-conditions.md` (around lines 23-29) is the only page that describes the
current behaviour ("always pair `onFail: retry` with a `retryPrompt`").

## Steps to Reproduce

Drive `EndConditionHandler.handleEndConditionResult` with a stub evaluator that always fails and
default settings:

| endCondition | Retries sent | Documented |
|---|---|---|
| `{onFail: retry}` | 0 | 1 |
| `{onFail: retry, maxRetries: 3}` | 0 | 3 |

## Root Cause

`PromptQueue.canRetry` (around lines 1245-1262) returns false whenever `resolveRetrySettings`
yields no `retryPrompt`. With no step `retryPrompt` and an empty
`defaults.endCondition.retryPrompt`, there never is one.

## Suggested Fix

When `onFail` (or the retry direction in play) is `retry`, don't require a configured template:
let `canRetry` pass on budget alone and let `buildRetryPrompt` use its fallback text (the fallback
already includes expected/actual and the script output). Keep the existing behaviour where a
`retryPrompt` also enables retries under the default `onFail: stopWorkflow`; that is documented
in `docs/workflows/end-conditions.md` and is out of scope here. Update `end-conditions.md` so it no
longer says a retry prompt is required for `onFail: retry`, and make sure the schema description,
troubleshooting page and `ExecutionPreviewService` agree with the code afterwards (regenerate
schema docs if a schema description changes).

Regression tests in `EndConditionHandler.test.ts`: `{onFail: retry}` → exactly 1 retry using the
fallback prompt; `{onFail: retry, maxRetries: 3}` → 3 retries. Note the existing `createPrompt`
helper injects a `retryPrompt`, which is why current tests don't catch this.
