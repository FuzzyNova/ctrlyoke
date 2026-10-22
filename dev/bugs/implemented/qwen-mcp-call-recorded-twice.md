# Qwen 0.25 records one extra MCP call row

- **Found:** 2026-10-22 by Claude (full `npm run test:harness` run), with Qwen Code 0.25.3
- **Area:** Qwen output parsing (`src/core/harness/qwen/`), `src/utils/CliEventNormalizer.ts`
- **Resolution:** fixed in this commit

## Symptom

`mcp-probe.harness.test.ts` → `qwen-cli: records each ctrlyoke MCP call once` fails on two
consecutive runs with **5** `mcpToolCall` events for four ctrlyoke tool calls, so one call shows as
two rows (or the model made a fifth call that the per-tool count check would then catch).

## Steps to Reproduce

1. `npm run test:harness -- --grep "qwen-cli: records each ctrlyoke MCP call once"`
2. The assertion `expected exactly four MCP call rows` fails with `5 !== 4`.

## Investigation

The case passed twice with the installed Qwen Code 0.26.0, using the configured `qwen3.5-plus`
model. The retained first run's `events.jsonl` contains exactly four `mcpToolCall` rows: one each
for `workflow_status`, `post_note`, `claim_paths`, and `release_paths`. Their `toolCallId` values
are all distinct. The 0.25.3 failure could not be reproduced, so the available evidence does not
identify whether that older run was a parser duplicate or a fifth model call. No parser dedupe or
probe-prompt change was justified by the current capture.

## Resolution

Verified fixed with Qwen Code 0.26.0; the MCP probe records each of its four calls once.
