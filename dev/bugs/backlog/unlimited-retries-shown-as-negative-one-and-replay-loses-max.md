# Unlimited retries display as "Retry N of -1", and replay rebuilds the retry maximum from the raw step field

- **Found:** 2026-09-30 by the bug-backlog workflow final step (claude-cli); traced in code
- **Area:** `src/core/EndConditionHandler.ts` (~357-391), `src/core/WorkflowInstance.ts` (`updateRetryAttempt` forwarding), `PromptStepDetails.tsx` (~151, under `src/ui/webview-react/components/`), `src/core/OutputCaptureBuffer.ts` (~209-211, ~271-273, ~508-510)
- **Severity:** low

## Symptom

1. `endCondition: { onFail: retry, maxRetries: -1 }` (`-1` is documented as
   unlimited) shows `Retry 1 of -1` on the step row. The status messages read
   `Retrying Prompt 1 (Attempt 1/-1)` and `Re-running Prompt 1 (Pass retry 1/-1)`.
2. After switching workflows or reloading the webview mid-retry, `OutputCaptureBuffer`
   rebuilds `maxRetries` from `step.endCondition?.maxRetries ?? attemptIndex`. That
   ignores inherited workflow or `defaults.endCondition` values, the implicit 1 for
   `onFail: retry`, and `errorBehavior.maxRetries` for harness-error retries. So a
   live `Retry 1 of 3` can come back as `Retry 1 of 1`.

## Root Cause

The raw `-1` sentinel is passed to user-facing text with no `isUnlimited` check.
The replay path reads the unresolved step field instead of the effective value.

## Suggested Fix

Add one shared formatter for the retry denominator that renders unlimited as `∞`
(or "unlimited"). Use it in the status messages and in `PromptStepDetails`. In
`OutputCaptureBuffer`, record the `maxRetries` actually sent via
`updateRetryAttempt` / `scheduleRetry`, or resolve it via
`PromptQueue.getEffectiveMaxRetries`, and replay that instead of re-deriving it.
Add tests for both.
