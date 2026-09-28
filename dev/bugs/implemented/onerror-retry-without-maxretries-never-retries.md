# `errorBehavior: {onError: retry}` without `maxRetries` never retries, but the dashboard shows 1 retry

- **Found:** 2026-09-28 by lots-of-bug-fixes final step (Claude)
- **Area:** `src/core/WorkflowExecutor.ts`, `src/ui/webview-react/components/shared/ErrorBehaviorEditor.tsx`
- **Resolution:** fixed in this commit

## Symptom

`errorBehavior: {onError: retry}` is valid under the schema (`maxRetries` is optional), and
`validate` accepts it. At runtime an errored step is not retried at all: the verdict is `→ stop`.
Meanwhile the dashboard's error-behavior editor shows "1" retry for the same value. The engine,
the editor and end conditions disagree. End conditions already default a missing `maxRetries` to
1 when `retry` is chosen (`EndConditionHandler.ts`, around lines 156-166).

## Steps to Reproduce

1. Create a script step `{type: script, script: "exit 3", errorBehavior: {onError: retry}}` that
   errors (for example, give it a `timeoutSec: 1` with a script that sleeps 5 s, or point it at an
   unsupported `.xyz` file).
2. Run it headless. The step is not retried, and the output reports `→ stop`.
3. Open the same workflow in the dashboard. The error-behavior editor shows 1 retry.

## Root Cause

`canRetryErrorBehavior` (`WorkflowExecutor.ts`, around line 403) uses `maxRetries ?? 0`, while
`ErrorBehaviorEditor.tsx` renders `maxRetries ?? 1`.

## Suggested Fix

Single-source a default-retries constant (1, to match end conditions and the editor) and use it
in `canRetryErrorBehavior`, the retry scheduling and verdict text, and the editor. Document the
default in the schema `description` and regenerate the schema docs. Add an executor test for
`onError: retry` with no `maxRetries`.
