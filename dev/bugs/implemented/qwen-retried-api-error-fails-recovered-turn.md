# Qwen session-error detection fails a turn that Qwen's retry recovered

- **Found:** 2026-11-09 by the Phase 0 re-capture for `dev/backlog/ERROR_HANDLING_CONSISTENCY_PLAN.md` (Qwen Code 0.26.7)
- **Area:** `src/core/harness/qwen/QwenLogParser.ts`, `src/core/harness/CliLogMonitor.ts`
- **Resolution:** fixed in this commit

## Symptom

An interactive Qwen step can fail with a `429 ...` harness error even though Qwen retried the request, the turn succeeded, and `Stop` fired.

## Steps to Reproduce

1. Run interactive Qwen against an OpenAI-compatible endpoint that answers the first four chat requests with 429 and then succeeds.
2. The chat JSONL records `qwen-code.api_error` and a `request_lifecycle` ending `outcome: "error"`. A new lifecycle follows with a new `executionId` and the same `promptId`; it ends `outcome: "success"`, followed by `qwen-code.api_response` (`src/test/fixtures/harness-errors/qwen/interactive-outer-retried-429-session-log.jsonl`).
3. `QwenLogParser.readNewLines` (`:209`) maps the `api_error` to `ctrlyoke.session-error`, and `CliLogMonitor` (`:687`) resolves the step as `HARNESS_ERROR` as soon as that event arrives. The successful retry is never considered.

A single 429 that the OpenAI SDK retries internally writes no `api_error` (`interactive-sdk-retried-429-session-log.jsonl`), so only retries in Qwen's outer retry loop trigger this.

## Root Cause

An `api_error` record marks one failed attempt, not the outcome of the turn. Qwen's outer retry (`retryWithBackoff`) logs every attempt that reaches the logging content generator.

## Suggested Fix

Do not resolve on `api_error` alone. Hold the error for a short grace period, or until the turn settles, and cancel it if a later `request_lifecycle` with the same `promptId` starts. With a 401 no Stop arrives and no new lifecycle starts, so failing once the grace period ends keeps the hang fix. Add tests for both captured 429 fixtures and the 401 lifecycle fixture.
