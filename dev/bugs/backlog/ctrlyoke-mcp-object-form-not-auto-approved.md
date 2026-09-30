# Claude/Copilot don't auto-approve ctrlyoke MCP tools when `mcpServers` uses the object form

- **Found:** 2026-09-30 by the bug-backlog workflow final step (claude-cli)
- **Area:** `src/core/harness/claude/ClaudeCliProvider.ts` (~305–311), `src/core/harness/copilot/CopilotCliProvider.ts` (~307–313)
- **Severity:** medium

## Symptom

`mcpServers` accepts the ctrlyoke server either as the string `"ctrlyoke"` or as
the object form `{ id: "ctrlyoke", deniedTools: [...] }`, which is schema-valid
(see implemented `schema-rejects-ctrlyoke-mcp-server-denied-tools`) and is what the
dashboard's MCP editor writes when a user unchecks a ctrlyoke tool. With the
object form the server is still attached (`hasCtrlYokeServer` →
`resolveCtrlYokeDenials` matches `server.id`), but the auto-approve flag is not
added:

- Claude: no `--allowed-tools mcp__ctrlyoke`
- Copilot: no `--allow-tool ctrlyoke`

So a headless run under a restrictive permission mode (Copilot custom
`toolPermissions`, Claude mode `none`) can't call the remaining ctrlyoke tools
(`append_step`, `post_note`, …) and there's nobody to approve them. Codex isn't
affected: it approves whenever the server is present.

## Steps to Reproduce

1. A Copilot step with `toolPermissions` in custom mode and
   `mcpServers: [{ id: ctrlyoke, deniedTools: [remove_step] }]`.
2. Inspect the prepared CLI args (unit-level: call the provider's arg builder with
   that resolved property set).
3. No `--allow-tool ctrlyoke` is present. The same step written as
   `mcpServers: [ctrlyoke]` gets it.

## Root Cause

Both providers check `mcpServersResolved.includes("ctrlyoke")`, which only matches
the bare-string form, rather than using the shared
`hasCtrlYokeServer(resolvedProperties)` from
`src/core/harness/shared/CliProviderUtils.ts` that the MCP preparation itself uses.
The literal `"ctrlyoke"` is also a hardcoded flow-control string.

## Suggested Fix

Replace both checks with `hasCtrlYokeServer(workflowContext.resolvedProperties)`
(or with a flag returned by the MCP preparation saying whether the ctrlyoke server
was attached), so auto-approval and attachment can't disagree. Denied ctrlyoke tools
are already removed from the tool list by `resolveCtrlYokeDenials`. Check whether
Claude/Copilot also need the denied tools passed as explicit disallow flags so that
approving the whole server doesn't re-enable them. Grep the other providers (Qwen,
OpenCode, Antigravity) for the same pattern. Unit tests for Claude and Copilot arg
building with the object form (with and without `deniedTools`) and with the string
form.
