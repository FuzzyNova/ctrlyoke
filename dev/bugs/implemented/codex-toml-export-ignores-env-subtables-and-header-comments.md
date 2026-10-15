# Codex TOML export/remove ignores `[mcp_servers.<id>.env]` subtables and header comments, producing invalid or corrupted config.toml

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/utils/HarnessMcpExporter.ts`
- **Resolution:** fixed in this commit

## Symptom

Exporting or removing an MCP server for Codex can leave `config.toml` unparseable or semantically invalid, or silently delete an unrelated server:

- With the `[mcp_servers.<id>.env]` subtable layout, export writes a second `env` definition and Codex refuses to load its config.
- Removal leaves an orphaned env table. That table implicitly defines a server with no `command` or `url`, which Codex rejects.
- A server header with a trailing comment is absorbed into the block above it and deleted along with that block.

## Steps to Reproduce

1. Create `~/.codex/config.toml` containing:
   ```toml
   [mcp_servers.foo]
   command = "npx"
   [mcp_servers.foo.env]
   API_KEY = "x"
   ```
2. In ctrlyoke, define MCP server `foo` with a command and an `env` map, then export it to Codex at user scope (`HarnessMcpExporter.export(servers, 'codex-cli', 'user')`).
3. Inspect `config.toml`. It still contains `[mcp_servers.foo.env]` / `API_KEY = "x"`, followed by `[mcp_servers."foo"]` with `env = { ... }`. A TOML parser (and Codex) rejects the file because `env` is defined twice.
4. Restore the original file and call `HarnessMcpExporter.remove(['foo'], 'codex-cli', 'user')`. The result keeps `[mcp_servers.foo.env]`, so `mcp_servers.foo` still exists with no command or url, and Codex rejects it.
5. Separately, use a file with `[mcp_servers.a]` / `command = "x"` followed by `[mcp_servers.bar] # note` / `command = "y"`, and remove or re-export `a`. Server `bar` is deleted as well, because its header was folded into block `a`.

## Root Cause

- `src/utils/HarnessMcpExporter.ts:399-404` (`writeCodexTomlFile`) and `:459-464` (`removeCodexTomlServers`) detect section starts with `trimmed.startsWith("[") && trimmed.endsWith("]")`. A header with a trailing `# comment` does not match, so its lines are merged into the preceding block.
- `parseTomlTargetSectionId` (`:301-325`) returns the whole dotted remainder after `mcp_servers.`, so `[mcp_servers.foo.env]` yields `foo.env`. The block filters at `:420-424` and `:481-487` match only exact ids, so the `.env` and `.headers` subtables of server `foo` are never treated as part of it.
- `toCodexBlock` (`:285-296`) always writes `env` and `headers` as inline tables, which conflicts with any subtable that was kept.
- `src/utils/McpDiscoveryUtils.ts:490-516` (`parseTomlMcpServerKey`) already maps `.env`/`.headers` subtables to their parent id. The two parsers read the same file but have drifted apart.

## Suggested Fix

- Use one shared helper for both the exporter and discovery, built on `McpDiscoveryUtils.parseTomlMcpServerKey` or moved out of it. It should map `[mcp_servers.<id>]`, `[mcp_servers.<id>.env]`, `[mcp_servers.<id>.headers]`, and any other `[mcp_servers.<id>.*]` subtable to the parent `<id>`, so that export and remove drop every block belonging to the target server.
- Detect headers with a pattern that allows a trailing comment and handles `[[...]]` array tables, e.g. `/^\s*\[\[?([^\]]*)\]\]?\s*(#.*)?$/`.
- A better option is to round-trip through a real TOML library (e.g. `smol-toml` or `@iarna/toml`), or to remove the server's whole subtree before emitting its keys.
- Add `HarnessMcpExporter` tests for the subtable layout (export with `env`, and remove) and for a commented header, and assert that the output parses as valid TOML.

## Decision

Settled by Nathan on 2026-10-14. Fix the hand-rolled section-header matching (subtables, `[[array]]` tables, trailing `# comments`) with thorough tests. Do not add a TOML library. Parsing and re-serializing would destroy the user's formatting and comments in `~/.codex/config.toml`.
