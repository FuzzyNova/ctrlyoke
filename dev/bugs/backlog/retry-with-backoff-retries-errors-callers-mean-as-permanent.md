# `retryWithBackoff` keeps retrying errors callers rethrow to stop it, and replaces the real error

- **Found:** 2026-09-28 by lots-of-bug-fixes final step (Claude)
- **Area:** `src/utils/RetryUtils.ts`, `src/core/harness/shared/CliProviderUtils.ts`, `src/utils/ModelRegistry.ts`
- **Severity:** medium

## Symptom

When a CLI version/availability check fails for a reason other than a Windows file lock (for
example the CLI is not installed, or the command times out), the check still runs all four
attempts with 200/500/1000 ms backoff and then throws a generic
`Version command failed: <command>` instead of the real error. With the 30 s
`CLI_VERSION_CHECK_TIMEOUT_MS`, a hanging Copilot version check can take about two minutes instead
of 30 s. `ModelRegistry` logs a missing or broken Copilot CLI as unavailable "after retries (file
lock)", which is misleading.

## Steps to Reproduce

Bundle `CliProviderUtils` with a stubbed `vscode` module and call
`runVersionCommand("ctrlyoke-nonexistent-cli-xyz --version", opts)`:

- without `retryWindowsFileLockErrors`: fails in ~430 ms with `spawn ... ENOENT`;
- with `retryWindowsFileLockErrors`: fails in ~1730 ms with
  `Version command failed: ctrlyoke-nonexistent-cli-xyz --version`.

## Root Cause

`retryWithBackoff`'s catch block (around lines 233-243 of `RetryUtils.ts`) stops early only for
`PermanentFailureError`; any other thrown error falls through to the next attempt. Callers use a
plain rethrow to mean "stop now":

- `CliProviderUtils.ts` (around lines 208-224) returns `null` for file-lock errors and
  `throw error` for everything else;
- `ModelRegistry.ts` (around lines 115-127) does `throw error; // permanent failure - stop retrying`.

After exhausting attempts `retryWithBackoff` returns `undefined`, so the original error is lost.

## Suggested Fix

Give `retryWithBackoff` a way to stop and surface the original error (for example a
`PermanentFailureError` that carries a `cause` which `retryWithBackoff` rethrows, or an option to
rethrow non-retryable errors), and use it in both callers so the ENOENT/timeout message reaches
the user. Check other `retryWithBackoff` callers for the same pattern. Add unit tests: a
non-file-lock error stops after one attempt and propagates its message; a file-lock error still
retries.
