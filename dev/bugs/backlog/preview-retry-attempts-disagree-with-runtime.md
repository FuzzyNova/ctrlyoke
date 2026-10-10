# The dry-run preview's "Maximum attempts" disagrees with the runtime retry budget

- **Found:** 2026-10-10 by claude-cli bug-hunt final step (reproduced with a scratch `npx tsx` script calling both code paths)
- **Area:** `src/core/ExecutionPreviewService.ts` (`buildConditions`), `src/core/PromptQueue.ts` (`resolveRetrySettings`, `canRetry`), `src/core/EndConditionHandler.ts`
- **Severity:** low

## Symptom

| endCondition                        | Runtime attempts on failure | Preview "Maximum attempts" |
| ----------------------------------- | --------------------------- | -------------------------- |
| `{ maxRetries: 3 }`                 | 1                           | 4                          |
| `{ maxRetries: 3, onFail: continue }` | 1                         | 4                          |
| `{ onFail: retry }`                 | `DEFAULT_ERROR_BEHAVIOR_RETRIES` + 1 | 2                 |
| `{ retryPrompt: "…" }` with a settings default `maxRetries` | default + 1 | 1         |

In the `{ maxRetries: 3 }` case, the runtime also reports "End condition failed
after 0 retries." (`EndConditionHandler.ts` ~291-294), because the headline
checks `maxRetries > 0` instead of whether a retry was possible.

## Steps to Reproduce

Build the execution preview for a step with each end condition above and
compare `conditions.retry.maxAttempts` with the attempts the runtime makes
(`PromptQueue.canRetry`). Without a default retry prompt configured, the
runtime never retries `{ maxRetries: 3 }`.

## Root Cause

`ExecutionPreviewService.buildConditions` (~1266-1275) computes retries as
`end.maxRetries ?? (retry action ? 1 : 0)`. The runtime's rule lives in the
private `resolveRetrySettings` and `canRetry` (`src/core/PromptQueue.ts`
~133-171 and ~1305-1325). There, retries need a `retryPrompt` (own or settings
default) or `onFail: retry`. A retry action defaults to
`DEFAULT_ERROR_BEHAVIOR_RETRIES`, and a bare `retryPrompt` uses the settings
default `maxRetries`. The two implementations drifted.

## Suggested Fix

Move `resolveRetrySettings` plus the `canRetry` eligibility rule into one
exported, pure helper (taking the settings defaults as input, or reading
`ConfigurationUtils` the same way). Use it in both `PromptQueue` and
`ExecutionPreviewService`, so the preview shows exactly what the runtime will
do. Base the "failed after N retries" headline on the retries actually
permitted. Tests in `src/test/unit/ExecutionPreviewService.test.ts` covering
each row of the table.
