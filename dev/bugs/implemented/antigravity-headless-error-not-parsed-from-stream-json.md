# Antigravity headless API errors are classed as a process exit instead of a harness error

- **Found:** 2026-11-09 by the Phase 0 re-capture for `dev/implemented/ERROR_HANDLING_CONSISTENCY_PLAN.md` (agy 1.5.3)
- **Area:** `src/core/harness/antigravity/AntigravityLogParser.ts`, `src/core/harness/antigravity/AntigravityCliProvider.ts`
- **Resolution:** fixed in this commit

## Symptom

A headless Antigravity step that hits a provider API error fails as `PROCESS_EXIT` ("process exited unexpectedly"), using a stderr summary, instead of as `HARNESS_ERROR` carrying the provider message. Phase 2 (H2) meant to give Antigravity `metadata.error`, but that path never fires against the real CLI.

## Steps to Reproduce

1. Run `agy --print ... --output-format stream-json` against an endpoint that answers with a 401.
2. stdout ends with a `result` event: `status: "ERROR"` and the text in `error` (`src/test/fixtures/harness-errors/antigravity/headless-stream-json-error.jsonl`). The process exits 3.
3. `transcript_full.jsonl` holds only the user input; no `SYSTEM`/`ERROR_MESSAGE` entry is written.
4. `CliResponseCollector.getHeadlessFailure` finds no `metadata.error` and no `extractErrorFromStdout`, so it falls through to the non-zero exit branch.

## Root Cause

`AntigravityLogParser.extractSessionError` (`:355`) only reads a transcript `ERROR_MESSAGE` entry, which agy 1.5.3 does not write for API errors. That shape was synthesized in Phase 2 without a capture.

## Suggested Fix

Implement `extractErrorFromStdout` on `AntigravityCliProvider`, reading the stream-json `result` event (`ANTIGRAVITY_STREAM_JSON_EVENTS.RESULT`) with `status: "ERROR"` and a non-empty `error`. Keep the transcript path as a fallback. Cover it with the captured fixture.
