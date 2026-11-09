# Claude StopFailure shows the error category instead of the error text

- **Found:** 2026-11-09 by the Phase 0 re-capture for `dev/implemented/ERROR_HANDLING_CONSISTENCY_PLAN.md` (Claude Code 2.1.319)
- **Area:** `src/core/harness/claude/ClaudeNotificationMonitor.ts`
- **Resolution:** fixed in this commit

## Symptom

An interactive Claude step that fails with a non-retryable API error is reported as `unknown`, not as the provider's message (for example `API Error: 400 ... is not a valid model`).

## Steps to Reproduce

1. Run interactive Claude with `ANTHROPIC_BASE_URL` pointing at a server that answers with `400 invalid_request_error`.
2. `StopFailure` fires with the payload in `src/test/fixtures/harness-errors/claude/stopfailure-hook-input.json`.
3. ctrlyoke fails the step with the message `unknown`.

## Root Cause

`describeHookError` (`ClaudeNotificationMonitor.ts:35-46`) returns the first non-empty string among `error.message`, `error`, `error_details` and `last_assistant_message`. In the real payload, `error` is a category string (`"unknown"`). `error_details` is absent, and the text is only in `last_assistant_message`, so the category wins.

## Suggested Fix

Prefer `last_assistant_message`, then `error_details` when present. Treat `error` as a category: put it in `FailureRecord.detail.errorType`, or use it as the message only when nothing else is present. Add a unit test that uses the captured fixture.
