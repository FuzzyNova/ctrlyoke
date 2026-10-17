# Codex TOML export duplicates a server written as an inline `[mcp_servers]` entry

- **Found:** 2026-10-15 by the bug drain 3 review (follow-up to `c07b600e0`)
- **Area:** `src/utils/HarnessMcpExporter.ts`, `src/utils/McpDiscoveryUtils.ts`
- **Resolution:** fixed in this commit

## Symptom

If `~/.codex/config.toml` (or the workspace `.codex/config.toml`) declares a server as an
inline table under a bare `[mcp_servers]` header, exporting that server from ctrlyoke
appends a second definition. The result is invalid TOML, so Codex refuses to load the
config. Removing the server has no effect, and discovery doesn't list it.

## Steps to Reproduce

1. Write this config:
   ```toml
   [mcp_servers]
   foo = { command = "node", args = ["a.js"] }
   ```
2. Export server `foo` to Codex from the MCP manager.
3. The file now also has `[mcp_servers.foo]`, which defines `foo` a second time.

## Root Cause

`writeCodexTomlFile` and `removeCodexTomlServers` work on whole table blocks. A block is
attributed to a server through `getTomlMcpServerSectionId`, which needs the server id in
the header (`[mcp_servers.<id>…]`). The bare `[mcp_servers]` table maps to no server, so
its `foo = {…}` key/value line is always kept. Dotted keys inside it
(`foo.command = "node"`) have the same problem.

## Suggested Fix

Inside a bare `[mcp_servers]` block, treat each top-level `<id> = …` or `<id>.<key> = …`
assignment (including a multi-line inline value) as belonging to `<id>`:

- **Export and remove:** drop those lines for the target ids.
- **Discovery:** parse the inline table.

Keep the line-preserving approach; per the bug drain 3 decision, don't add a TOML
re-serializer.
