# Antigravity Drops Usage From an Unterminated Final Stream Record

- **Found:** 2026-09-28 by Codex during dead-method review
- **Area:** `src/core/harness/antigravity/AntigravityStreamJsonUsage.ts`
- **Resolution:** fixed in this commit

## Symptom

When Antigravity's final `result` usage event reaches stdout without a trailing
newline, its usage may be missing from the final step output.

## Steps to Reproduce

1. Enable Antigravity stream-json usage observation.
2. End stdout with a valid `result` JSON record that has no trailing newline.
3. Observe that the final usage record is not included in the accumulator snapshot.

## Root Cause

`AntigravityStreamJsonUsageAccumulator.ingest()` retains incomplete lines until
another newline arrives. `flush()` parses that remaining line, but no process
exit path calls it. `HeadlessLogTail.finish()` flushes its own session-ID
remainder, while `observeHeadlessStdout()` only forwards live chunks to the
usage accumulator.

## Suggested Fix

Flush the provider's stream-json usage accumulator after headless stdout has
fully ended and before final usage is read from `AntigravityLogParser`.
