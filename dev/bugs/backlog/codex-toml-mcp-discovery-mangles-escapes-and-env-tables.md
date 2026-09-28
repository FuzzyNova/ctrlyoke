# Codex `config.toml` MCP discovery turns `\\t`/`\\n` in Windows paths into tabs/newlines and drops `[mcp_servers.<id>.env]` tables

- **Found:** 2026-09-27 by the long-running bug-fix workflow final step (claude-cli, helper agent)
- **Area:** `src/utils/McpDiscoveryUtils.ts` (`unquoteTomlString`, `parseTomlMcpServerKey`, `normalizeCodexToml`)
- **Severity:** medium

## Symptom

Reproduced by calling the compiled `safeDiscoverLocalMcpServers(ws)` against a scratch
`<ws>/.codex/config.toml`.

1. **Escapes decoded twice.**

   ```toml
   [mcp_servers.winsrv]
   command = "C:\\tools\\node.exe"
   args = ["C:\\new\\server.js"]
   ```

   Discovered `command` is `"C:<TAB>ools<LF>ode.exe"` and `args[0]` is `"C:<LF>ew\server.js"`.
   Expected `C:\tools\node.exe` and `C:\new\server.js`. Every basic-string Windows path whose
   segment starts with `n`, `r`, `t` or `"` is corrupted.

2. **Env sub-table dropped.** The layout Codex's own docs use:

   ```toml
   [mcp_servers.ctx7]
   command = "npx"
   args = ["-y", "@upstash/context7-mcp"]

   [mcp_servers.ctx7.env]
   API_KEY = "abc"
   ```

   `ctx7` is discovered with no `env`; `API_KEY` is silently lost.

## Steps to Reproduce

1. Create either `config.toml` above under `<workspace>/.codex/`.
2. Run MCP discovery (e.g. open the MCP servers editor in the dashboard, or call
   `safeDiscoverLocalMcpServers`).
3. Inspect the discovered server.

## Root Cause

- `unquoteTomlString` (`McpDiscoveryUtils.ts:~335-352`) undoes escapes with a chain of
  `.replace()` calls, running `\\\\` → `\\` first. The backslash it just produced is then re-read as
  the start of `\n`, `\t`, `\r` or `\"`.
- `parseTomlMcpServerKey` (`~470-486`) treats `mcp_servers.ctx7.env` as a new server id `ctx7.env`.
  That flushes `ctx7` early, and `ctx7.env` is then discarded because it has no command.

## Suggested Fix

- Decode basic strings in a single pass, e.g.
  `inner.replace(/\\(["\\nrt])/g, (_, c) => ({ n: "\n", r: "\r", t: "\t" })[c] ?? c)`.
- When the section header is `mcp_servers.<id>.env` (or `.headers`, if supported), keep the current
  server as `<id>` and route `key = value` lines into that map.
- Consider replacing the hand-rolled parser with a real TOML parser if one is already a dependency.
- Tests: the Windows-path example round-trips exactly, and the env sub-table example yields
  `env: { API_KEY: "abc" }`.
