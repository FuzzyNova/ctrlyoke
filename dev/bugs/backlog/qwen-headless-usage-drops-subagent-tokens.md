# Headless Qwen steps leave subagent tokens out of usage and cost

- **Found:** 2026-11-25 by bug-hunt final step (claude-cli subagent, reproduced with a scratch unit test)
- **Area:** `src/core/harness/qwen/QwenHarnessAdapter.ts`, `src/core/harness/qwen/QwenLogParser.ts`
- **Severity:** medium (undercounts tokens and cost on every headless qwen-cli step that delegates to subagents; shipped since v0.3.0)

## Symptom

The CHANGELOG (around lines 1048-1051, from commit 759434578) says headless
Qwen Code uses its process-wide usage, taken from the stdout
`{"type":"result","usage":{…}}` record, and for that reason headless mode
turns off per-subagent usage counting. In practice the `result` record never
reaches the parser. Headless totals are main-session-only accumulated
`usageMetadata` with `totalConfidence: 'accumulated'`, and subagent tokens are
dropped from both paths with no lower-bound marker.

## Steps to Reproduce

1. Build a `QwenHarnessAdapter`, call `buildHeadlessArgs` (which disables
   subagent usage), then run `adapter.logParser.extractResponse` over the
   events of `src/test/fixtures/qwen/headless-golden.session.jsonl`, the way
   the LOG pipeline does.
2. `totalConfidence` is `'accumulated'`, not `'provider'`, and the totals do
   not match the `result.usage` in `headless-golden.stdout.jsonl`.

## Root Cause

- `QwenHarnessAdapter.ts:278`: `headlessSource = HEADLESS_SOURCE_MODES.LOG`;
  Qwen has no `parseHeadlessStdout`/`observeHeadlessStdout`.
- `QwenHarnessAdapter.ts:871`: `buildHeadlessArgs` calls
  `this.logParser.setSubagentUsageEnabled(false)`.
- In LOG mode, `CliResponseCollector.ts:248-251` parses only
  `headlessLogTail.getEvents()`, and `HeadlessLogTail` fills those events from
  the session log alone; stdout is used only to capture the session ID.
- Qwen's session JSONL contains no `result` record (the golden fixture has
  none); only stdout does. So the `QWEN_EVENT_TYPES.RESULT` branch at
  `QwenLogParser.ts:420` never runs in production.
- The only test ("uses headless result usage as the whole-process total" in
  `LogParsers.test.ts`) hands a synthetic `result` event to `extractResponse`
  directly instead of going through the LOG pipeline.
- Latent second defect on the same path: `QwenLogParser.ts:542` reads
  `cached_tokens ?? cachedContentTokenCount`, but the real stdout record uses
  `cache_read_input_tokens`, so once wired up cache hits would be priced as
  full-price input.

## Suggested Fix

Feed the stdout `result` record into the parser in headless mode, e.g. an
`observeHeadlessStdout` hook on the Qwen adapter (compare Antigravity's
`AntigravityStreamJsonUsageAccumulator`) whose terminal usage the parser
merges as the provider total. If that is not feasible, stop disabling subagent
usage in headless mode instead. Read `cache_read_input_tokens` as the cached
count. Add a test that runs both golden fixtures through the real
`HeadlessLogTail`/`CliResponseCollector` path.
