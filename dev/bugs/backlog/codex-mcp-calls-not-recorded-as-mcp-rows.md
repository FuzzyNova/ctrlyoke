# Codex 0.163 MCP tool calls are not recorded as MCP call rows

- **Found:** 2026-10-22 by Claude (full `npm run test:harness` run), with codex-cli 0.163.0
- **Area:** Codex output parsing (`src/core/harness/codex/`), `src/utils/CliEventNormalizer.ts`
- **Severity:** medium

## Symptom

`mcp-probe.harness.test.ts` → `codex-cli: records each ctrlyoke MCP call once` fails on two
consecutive runs: the step succeeds, but the run's timeline holds **0** `mcpToolCall` events where
the four ctrlyoke tool calls (`workflow_status`, `post_note`, `claim_paths`, `release_paths`) should
appear. The output pane would show no MCP call rows for a Codex step.

## Steps to Reproduce

1. `npm run test:harness -- --grep "codex-cli: records each ctrlyoke MCP call once"`
2. The assertion `expected exactly four MCP call rows` fails with `0 !== 4`.

## Root Cause

Not yet investigated. Copilot, Claude, OpenCode and Antigravity pass the same case in the same
run, so the likeliest cause is a change in the shape of Codex's MCP tool-call events that the
parser no longer maps to `CLI_EVENT_TYPES.MCP_TOOL_CALL`. Which Codex release changed it is not
known.

## Suggested Fix

Capture a raw Codex 0.163 transcript of an MCP call, add it as a parser fixture, and accept the
new shape alongside the old one (parse by shape, per `dev/reference/HARNESS_VERSION_SUPPORT.md`).
