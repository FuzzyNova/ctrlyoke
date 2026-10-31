# Antigravity drops every tool from an MCP server whose id or tool name contains a dot

- **Found:** 2026-10-31 by Claude Code (Antigravity permission-rules spike, agy 1.4.12, Windows 11)
- **Area:** `src/core/harness/antigravity/AntigravityCliProvider.ts` (`planMcpConfigArgs`)
- **Severity:** medium

## Symptom

On Antigravity, a workflow MCP server registered under an id such as `opencode.probe-server`
(or one exposing a tool such as `blocked.probe`) loads, but none of its tools reach the
model. The model reports that the tool "is not available", and the step quietly does without
it. No ctrlyoke diagnostic is shown. agy's own log
(`~/.gemini/antigravity-cli/log/cli-*.log`) has one error per tool:

```
mcp_client_session_instance.go:207] encountered invalid tool probe_tool: tool name mcp_ctrlyoke.probe-server_probe_tool violates ^[a-zA-Z0-9_-]{1,64}$
```

agy builds the model-facing name `mcp_<serverId>_<toolName>` and rejects any tool whose name
fails `^[a-zA-Z0-9_-]{1,64}$`. It does not normalize the id. So a dot or space in either
part, or a combined name over 64 characters, drops the tool.

## Steps to Reproduce

1. Write `.agents/mcp_config.json` in an empty workspace with one stdio server keyed
   `ctrlyoke.probe-server`. The probe from `buildMcpProbeServerScript()` in
   `src/test/harness/helpers/harnessRunner.ts`, exposing `probe_tool`, works.
2. `agy -p "Call the probe_tool tool from the ctrlyoke.probe-server MCP server exactly once." --dangerously-skip-permissions`
3. The tool is never called. Renaming the key to `ctrlyoke-probe` makes the same run call it.

## Root Cause

`planMcpConfigArgs` writes `userServers` into `.agents/mcp_config.json` under their
ctrlyoke ids unchanged (via `CliProviderUtils.buildSettingsJsonMcpEntries`). ctrlyoke
accepts dots in server ids, and OpenCode's harness tests use `opencode.probe-server` on
purpose. Antigravity has no such allowance and doesn't warn about the rejected tools.

## Suggested Fix

Sanitize the server key ctrlyoke writes for Antigravity: replace characters outside
`[A-Za-z0-9_-]` with `_` and keep the mapping stable. Then use the **same sanitized id** in
the `mcp(<server>/<tool>)` permission rules that
`dev/backlog/ANTIGRAVITY_PERMISSION_RULES_PLAN.md` emits. Report a compatibility
diagnostic when a sanitized id collides with another server, or when
`mcp_<id>_<tool>` would exceed 64 characters. Tool names belong to the server, so ctrlyoke
can't rename them. A tool name with a dot can only be diagnosed, not fixed.
