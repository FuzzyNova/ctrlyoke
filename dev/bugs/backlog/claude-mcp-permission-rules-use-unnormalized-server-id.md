# Claude ignores `autoApprove` and `deniedTools` for MCP server IDs with `.`, `/` or other characters

- **Found:** 2026-10-15 by Claude Code (bug-hunt final step; read from the installed Claude CLI bundle, not run)
- **Area:** `src/core/harness/claude/ClaudeCliProvider.ts`, `src/types/ToolPermissionUtils.ts`
- **Severity:** high

## Symptom

Take a server with ID `io.github.upstash/context7`, a realistic ID imported from VS Code
`mcp.json` (the schema puts no limit on IDs). Claude names its tools
`mcp__io_github_upstash_context7__*`, but ctrlyoke writes its rules with the raw ID, so:

- `autoApprove` has no effect, and a headless `dontAsk` run denies the tools;
- **`deniedTools` is not enforced**, so a tool the user meant to block stays callable.

## Steps to Reproduce

1. Configure an MCP server with ID `io.github.upstash/context7`, `autoApprove: true`, and
   `deniedTools: ["resolve-library-id"]`.
2. Run a `claude-cli` step.
3. ctrlyoke passes `--allowed-tools mcp__io.github.upstash/context7` and a deny rule
   `mcp__io.github.upstash/context7__resolve-library-id`. Neither matches the tool names Claude
   generates.

## Root Cause

- Allow rules: `ClaudeCliProvider.ts:335` (`` `mcp__${server.id}` ``) and `:342`
  (`` `mcp__${server.id}__${pattern}` ``).
- Deny rules: `ToolPermissionUtils.ts:24` (`` `mcp__${server.id}__${tool}` ``).
- Claude builds MCP tool names as `"mcp__" + normalizeNameForMCP(name) + "__" + tool`, where the
  normalizer is `name.replace(/[^a-zA-Z0-9_-]/g, "_")`. Its rule matcher compares the server
  segment exactly.

Codex already sanitizes server IDs (`sanitizeCodexConfigKeySegment`), so this gap is Claude's
alone.

## Suggested Fix

Normalize the server segment with `/[^a-zA-Z0-9_-]/g → "_"` wherever Claude allow and deny rules
are built. Put the normalizer in one helper used by both `ClaudeCliProvider` and the Claude path
of the deny-rule merge. Don't change the shared `mergeServerDeniedTools` output for other
harnesses unless they normalize the same way. Add a unit test with a dotted, slashed server ID for
both the allow and the deny rule.
