# Qwen connects to remote streamable-HTTP MCP servers as SSE

- **Found:** 2026-10-21 by a research subagent (Qwen minimum-version review), from Qwen Code source 0.14.1, 0.15.5, 0.20.1 and 0.25.3
- **Area:** `src/core/harness/shared/CliMcpConfigGenerator.ts` (`buildUserServerEntry`), `src/core/harness/qwen/QwenCliProvider.ts` (`getMcpConfigArgs`)
- **Severity:** medium

## Symptom

A workflow MCP server with a `url` (default transport `streamable-http`) is likely unreachable on
Qwen, or connects with the wrong protocol.

## Steps to Reproduce

1. Configure a remote MCP server that only speaks streamable HTTP and attach it to a Qwen step.
2. Run the step and ask the model to call one of its tools.
3. Expected: the tool is listed. Likely actual: the connection fails because Qwen opened it as SSE.

Not yet run end to end; confirm before fixing.

## Root Cause

`buildUserServerEntry()` writes `{ url, type: "streamable-http" }`. Qwen's `createTransport`
ignores `type` and treats `url` as an SSE endpoint; it uses streamable HTTP only for `httpUrl`
(Qwen's bundled `mcp.md` and `settings.md` in 0.25.3 say the same). The only `streamable-http`
handling in Qwen 0.25.3 is for plugin MCP config, which `--mcp-config` servers never reach.

## Suggested Fix

Give Qwen a remote-entry mapping that writes `httpUrl` for `streamable-http` and `url` for `sse`,
through the existing per-harness `McpUserServerHarnessConfig` rather than a Qwen branch in the
shared generator. Cover it with a `test:harness` case against a streamable-HTTP server.
