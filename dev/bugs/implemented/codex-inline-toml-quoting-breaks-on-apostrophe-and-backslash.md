# Codex inline MCP TOML breaks on `'` in values; user MCP args/env have every `\` rewritten to `/`

- **Found:** 2026-09-30 by the bug-backlog workflow final step (claude-cli)
- **Area:** `src/core/harness/shared/CliMcpConfigGenerator.ts` (`quoteInlineTomlString`), `src/core/harness/codex/CodexCliProvider.ts` (~829–837)
- **Resolution:** fixed in this commit

## Symptom

1. **Apostrophes.** Codex MCP servers are passed as `-c mcp_servers.<id>={...}`
   inline TOML. `quoteInlineTomlString` wraps values in single quotes and
   "escapes" `'` by doubling it: `'O''Brien'`. TOML literal strings have **no**
   escapes, so that's a syntax error. `smol-toml` rejects
   `x={command='node',args=['C:/Users/O''Brien/srv.js']}` with "expected comma or
   end of structure". This affects the built-in ctrlyoke server entry (its env
   carries the workspace root and working-file path) as well as every user stdio
   and remote server. A workspace under a user profile like `C:\Users\O'Brien\…`
   produces an unparseable value. Codex falls back to treating an unparseable `-c`
   value as a plain string, so `mcp_servers.ctrlyoke` becomes a string rather than
   a table, and the ctrlyoke MCP server is lost (or config load fails). A value
   containing a newline also breaks a single-line literal string.
2. **Backslashes.** `CodexCliProvider` rewrites every `\` to `/` in user stdio
   server `args` and static `env` values. That's harmless for Windows paths, but it
   corrupts non-path values: `args: ["--pattern", "\\d+"]` becomes `/d+`,
   `env: { DOMAIN_USER: "CORP\\alice" }` becomes `CORP/alice`. Claude, Copilot and
   Qwen pass the same values through unchanged. The rewrite predates literal-string
   quoting (`a8a69c302`) and does nothing useful now.

## Steps to Reproduce

1. `CliMcpConfigGenerator.generateInlineTomlConfig('ctrlyoke', …)` with a workspace
   root of `C:\Users\O'Brien\proj`. The output contains `'C:\Users\O''Brien\proj'`.
2. Parse the value with `smol-toml` (already a dependency): it throws.
3. For the backslash issue: a Codex step with a user MCP server
   `{ id: x, command: node, args: ["srv.js", "--re", "\\d+"] }`. The generated
   `-c` arg contains `'/d+'`.

## Root Cause

`quoteInlineTomlString` (`CliMcpConfigGenerator.ts` ~185) applies SQL/PowerShell
quote doubling to a TOML literal string. `CodexCliProvider`'s
`normalizedArgs`/`normalizedEnv` blanket `replace(/\\/g, "/")`.

## Suggested Fix

Emit TOML **basic** strings with proper escaping. `JSON.stringify(value)` produces
a valid TOML basic string for any JS string: TOML basic-string escapes are a
superset of what JSON emits for `"`, `\`, control characters and `\uXXXX`.
`CodexInlineHooksBuilder` already relies on this. Single-source one TOML string
quoting helper and use it for every inline TOML value (strings, string arrays, env
tables). Then drop the backslash-to-slash normalization in `CodexCliProvider`.
Tests: round-trip generated inline configs through `smol-toml` for values with
`'`, `"`, `\`, newlines and non-ASCII, and assert that user args/env keep their
backslashes.
