# Qwen 0.25 records one extra MCP call row

- **Found:** 2026-10-22 by Claude (full `npm run test:harness` run), with Qwen Code 0.25.3
- **Area:** Qwen output parsing (`src/core/harness/qwen/`), `src/utils/CliEventNormalizer.ts`
- **Severity:** low

## Symptom

`mcp-probe.harness.test.ts` → `qwen-cli: records each ctrlyoke MCP call once` fails on two
consecutive runs with **5** `mcpToolCall` events for four ctrlyoke tool calls, so one call shows as
two rows (or the model made a fifth call that the per-tool count check would then catch).

## Steps to Reproduce

1. `npm run test:harness -- --grep "qwen-cli: records each ctrlyoke MCP call once"`
2. The assertion `expected exactly four MCP call rows` fails with `5 !== 4`.

## Root Cause

Not yet investigated. Check the run's `events.jsonl` for which tool appears twice and whether both
rows share a `toolCallId` (a parser duplicate) or not (a real second call).

## Suggested Fix

If the rows share a `toolCallId`, merge them in the Qwen parser or `normalizeCliEvents`; otherwise
make the probe prompt stricter.
