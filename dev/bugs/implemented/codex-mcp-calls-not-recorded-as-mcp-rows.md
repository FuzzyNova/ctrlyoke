# Codex 0.163 MCP tool calls are not recorded as MCP call rows

- **Found:** 2026-10-22 by Claude (full `npm run test:harness` run), with codex-cli 0.163.0
- **Area:** Codex output parsing (`src/core/harness/codex/`), `src/utils/CliEventNormalizer.ts`
- **Resolution:** fixed in this commit

## Symptom

`mcp-probe.harness.test.ts` → `codex-cli: records each ctrlyoke MCP call once` fails on two
consecutive runs: the step succeeds, but the run's timeline holds **0** `mcpToolCall` events where
the four ctrlyoke tool calls (`workflow_status`, `post_note`, `claim_paths`, `release_paths`) should
appear. The output pane would show no MCP call rows for a Codex step.

## Steps to Reproduce

1. `npm run test:harness -- --grep "codex-cli: records each ctrlyoke MCP call once"`
2. The assertion `expected exactly four MCP call rows` fails with `0 !== 4`.

## Root Cause

Codex 0.163 rollout logs represent executed MCP calls as `event_msg` records with
`payload.type: "item_completed"` and `payload.item.type: "McpToolCall"`. The item carries the
server, tool, arguments, result, and call ID. `CodexLogParser` handled the older
`response_item` tool-call formats but ignored these completed-item records, so interactive
steps could execute the calls without recording MCP rows. Codex can also emit these records
alongside an `exec` wrapper whose input contains the same calls; the parser now avoids recording
that same call twice.

## Fix

The Codex parser now maps the completed MCP item records in both batch and streaming output.
The fixture in `src/test/fixtures/mcp-probe/codex-cli-item-completed.jsonl` covers all four
ctrlyoke tools, and duplicate rows are suppressed when Codex also includes those calls in an
`exec` wrapper.
