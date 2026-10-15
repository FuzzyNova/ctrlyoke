# Copilot MCP autoApprove tool lists are emitted as bare `--allow-tool <tool>` without the server qualifier

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/core/harness/copilot/CopilotCliProvider.ts`
- **Severity:** medium

## Symptom

This is a security issue (it can grant too much permission) as well as a functional one.

On the copilot-cli harness, an MCP server's `autoApprove: [toolName, ...]` list does not auto-approve those tools. Headless and unattended Copilot runs therefore deny the tool calls the author meant to approve.

If a listed tool name matches a Copilot built-in permission kind (`write`, `shell`) or another MCP server's id, the generated `--allow-tool` flag approves that whole category instead. For example, an MCP tool named `write` pre-approves every built-in file write.

## Steps to Reproduce

1. Define a workflow step with harness `copilot-cli` and `mcpServers: [{ id: 'github', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], autoApprove: ['create_issue'] }]`.
2. Build the Copilot CLI args (e.g. with verbose logging or the execution preview). The argv contains `--allow-tool create_issue`, not `--allow-tool github(create_issue)`.
3. Run the step headless and have the agent call github's `create_issue`. Copilot does not treat it as pre-approved and denies it.
4. Change `autoApprove` to `['write']` (an MCP tool named `write`). The argv now contains `--allow-tool write`, which pre-approves all of Copilot's built-in file-write operations, not that one MCP tool.

## Root Cause

`src/core/harness/copilot/CopilotCliProvider.ts:342-344` pushes each `server.autoApprove` entry unqualified:

```ts
for (const pattern of server.autoApprove) {
  args.push("--allow-tool", pattern);
}
```

The `autoApprove === true` branch at line 336 scopes correctly (`--allow-tool <server.id>`), and the other harnesses qualify list entries with the server: `ClaudeCliProvider.ts:341` emits `mcp__${server.id}__${pattern}`, and `CodexCliProvider.ts:188-194` (`buildToolApprovalOverrideArgs`) builds per-server tool entries.

Copilot's permission syntax for one MCP tool is `<serverId>(<toolName>)`; `<serverId>` alone covers every tool on that server, and `shell(...)`/`write` are built-ins. `CopilotToolPermissionMapper.convertMcpPattern` (`src/core/harness/copilot/CopilotToolPermissionMapper.ts:189-198`, called from `convertToCopilotFormat` at line 159) already produces `serverId(toolName)` for permission patterns, but the autoApprove path does not use it.

No test covers the array branch for Copilot.

## Suggested Fix

- At `CopilotCliProvider.ts:343`, emit `--allow-tool ${server.id}(${pattern})` for each entry.
- Better: share one helper with `CopilotToolPermissionMapper`'s MCP conversion (e.g. a static `toCopilotMcpToolPattern(serverId, tool)`) so the format lives in one place.
- Add a `CopilotCliProvider` unit test for `autoApprove: ['create_issue']` that asserts `github(create_issue)`, and checks that an MCP server's list can never emit a bare built-in kind such as `write`.
- Consider tightening the schema description to say entries are tool names of that server.
