# Interactive harness hook error text is dropped

- **Found:** 2026-11-09 by error handling consistency plan
- **Area:** `src/core/harness/CliLogMonitor.ts`
- **Resolution:** fixed in this commit

## Symptom

Interactive Claude, Copilot and OpenCode hook failures display the generic “Harness reported an error” text instead of the error reported by the harness.

## Steps to Reproduce

1. Trigger a harness error hook containing an `error` payload.
2. Observe the failed step's error message.

## Root Cause

`describeHarnessError` inspected only `rawHookData.message`, while native hook payloads carry the text in harness-specific fields.

## Suggested Fix

Let each notification monitor extract its native hook error payload and surface the redacted, sanitized text.
