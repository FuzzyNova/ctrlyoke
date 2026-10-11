# A Codex MCP server ID containing `.` makes every Codex launch fail

- **Found:** 2026-10-10 by claude-cli bug-hunt final step (generated args run through installed codex-cli 0.162.0 with `codex -c '<arg>' mcp list`, no model call)
- **Area:** `src/core/harness/shared/CliMcpConfigGenerator.ts`, `src/core/harness/codex/CodexCliProvider.ts` (`buildToolApprovalOverrideArgs`)
- **Resolution:** fixed in this commit

## Symptom

An MCP server registered with an ID containing a dot — which VS Code's MCP
gallery produces in `.vscode/mcp.json` (e.g. `io.github.upstash/context7`), and
which `McpManagerSection.tsx` (`localEntryToServer`) imports verbatim as `id` —
makes every Codex step fail at startup:

```
Error: failed to load bootstrap configuration … invalid transport in 'mcp_servers.io'
```

IDs with `@`, spaces or `-` load fine; only `.` is fatal.

## Steps to Reproduce

1. `CodexCliProvider.planMcpConfigArgs(…, [{ id: "io.github.upstash/context7", command: "npx", args: [...] }])`
   produces `-c mcp_servers.io.github.upstash/context7={command="npx",…}`.
2. Run `codex -c '<that arg>' mcp list`.
3. Codex rejects the config. Expected: the server is configured.

Codex's `-c` key parser splits on every `.` and does **not** honour TOML key
quoting here: `mcp_servers."my.server"` fails the same way.

## Root Cause

- `CliMcpConfigGenerator.ts` (~251 stdio, ~308 HTTP) interpolates
  `serverName` unquoted into `mcp_servers.${serverName}={…}`.
- `CodexCliProvider.buildToolApprovalOverrideArgs` (~183) builds
  `mcp_servers.${server.id}.tools.${toolName}.approval_mode=…`, with the same
  problem for dotted tool names.

## Suggested Fix

Map Codex config key segments through one sanitizer (e.g. `.` → `_`, plus any
other character Codex's key parser can't accept) in the Codex path only, with a
collision check (two IDs mapping to the same key → log a warning and skip the
later one, or suffix it) and use the same mapping for the server ID in the
approval-override keys. Tool names in `autoApprove` that contain `.` cannot be
renamed (the server defines them); skip those overrides with a warning rather
than emitting a key that breaks the launch. Tests in
`src/test/unit/CodexCliProvider.test.ts` and
`src/test/unit/CliMcpConfigGenerator.test.ts`.
