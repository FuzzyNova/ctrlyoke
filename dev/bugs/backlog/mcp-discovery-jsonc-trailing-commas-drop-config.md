# MCP discovery silently ignores a JSONC config file that has a trailing comma

- **Found:** 2026-09-27 by the long-running bug-fix workflow final step (claude-cli, helper agent)
- **Area:** `src/utils/McpDiscoveryUtils.ts` (`readJsonFile`), `src/utils/JsoncUtils.ts`
- **Severity:** medium

## Symptom

`.vscode/mcp.json` is JSONC, and VS Code accepts trailing commas in it. With

```jsonc
{ "servers": { "gh": { "command": "npx", "args": ["-y", "server-github"], }, }, }
```

`safeDiscoverLocalMcpServers(ws)` returns no servers and reports no error. Removing the trailing
commas makes `gh` appear. Any MCP config read through `readJsonFile` behaves the same way.

## Steps to Reproduce

1. Write the file above to `<workspace>/.vscode/mcp.json`.
2. Run MCP discovery (dashboard MCP editor, or call `safeDiscoverLocalMcpServers`).
3. `gh` is missing.

## Root Cause

`readJsonFile` (`McpDiscoveryUtils.ts:~89-96`) calls `JSON.parse(stripJsonComments(content))`.
`stripJsonComments` (`JsoncUtils.ts`) only removes comments, so a trailing comma makes
`JSON.parse` throw and the `catch` returns `null`. The rest of the codebase
(`FileConfigBackend`, `OpenCodeInlineConfig`, `HarnessMcpExporter`) already parses JSONC with
`jsonc-parser`, which handles this.

## Suggested Fix

Parse with `jsonc-parser`'s `parse(text, errors, { allowTrailingComma: true })` (single-source the
JSONC read through whatever helper the other callers share), and delete `JsoncUtils.ts` if it has no
other users. Tests: a config with trailing commas and comments is discovered.
