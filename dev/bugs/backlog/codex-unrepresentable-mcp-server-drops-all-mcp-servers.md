# One Codex MCP server that cannot be represented silently drops every MCP server, including ctrlyoke's own

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/core/harness/codex/CodexCliProvider.ts`
- **Severity:** low

## Symptom

A Codex step can have an MCP server config with a composite secret value. Examples are `env: { TOKEN: "prefix-${secret:API_KEY}" }`, or a non-Authorization header such as `"Token ${secret:KEY}"`. When that happens, Codex launches with no `-c mcp_servers.*` overrides at all. The session is missing ctrlyoke's own MCP server (queue extension and coordination tools) and every other valid user MCP server. The only trace is a `Log.error` line in the session log. The dashboard shows nothing, and the step still runs.

## Steps to Reproduce

1. Enable the ctrlyoke MCP server (e.g. dynamic queue extension) for a workflow that uses harness `codex-cli`.
2. Add a stdio MCP server with `env: { TOKEN: "prefix-${secret:API_KEY}" }`, or a remote server with `headers: { "X-Api": "Token ${secret:KEY}" }`. Include another valid server too, and grant the secret.
3. Run the step.
4. Observe the result:
   - The Codex command line has no `-c mcp_servers.ctrlyoke...` override and no other server overrides.
   - The agent has no ctrlyoke MCP tools.
   - The session log contains `[CodexCliProvider] Failed to generate MCP config for Codex CLI`.
   - The UI shows no error.

## Root Cause

`splitCodexEnvironment` (`src/core/harness/codex/CodexCliProvider.ts:110-113`) and `splitCodexHeaders` (`:138-141`) throw when a secret is embedded in a larger string. This is deliberate, because Codex can only reference whole env vars.

`planMcpConfigArgs` puts the ctrlyoke entry (`:813-830`) and the whole per-server loop (`:837-899`) inside a single `try`. The `catch` at `:912-918` logs the error and returns `{ cliArgs: [], mutations: [], diagnostics: [] }`. That throws away the `configArgs` built so far and returns no diagnostic. The caller at `:349-372` reads empty args as "no MCP config" and continues.

Nothing rejects this config earlier: upstream validation (`SecretResolver.ts`, `McpServerNormalizer.ts`, and the schema's `mcpServers[].headers` description) accepts composite interpolations.

## Suggested Fix

Handle each server on its own:

- Wrap the split and generate calls for each user server in their own `try/catch`. On failure, `Log.warn` and skip only that server, the same way the SSE, missing-command and key-collision cases already `continue`.
- Push a diagnostic into the returned `diagnostics` so the dashboard shows the skipped server.
- Always keep the ctrlyoke server entry.

Another option is to fail the step on a hard error, by returning an error-severity diagnostic, instead of silently launching with no MCP config.

Add a unit test in `src/test/unit/CodexCliProvider.test.ts`. A composite env value on one server should leave the ctrlyoke entry and the other servers in `cliArgs`, and should produce a diagnostic.
