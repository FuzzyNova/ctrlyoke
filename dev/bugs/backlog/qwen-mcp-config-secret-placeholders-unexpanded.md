# Qwen may receive `${NAME}` secret placeholders unexpanded in `--mcp-config`

- **Found:** 2026-10-21 by a research subagent (Qwen minimum-version review), from Qwen Code source 0.15.5 and 0.25.3
- **Area:** `src/core/harness/shared/CliMcpConfigGenerator.ts` (`transformSecretMap`), `src/core/harness/qwen/QwenCliProvider.ts`
- **Severity:** medium

## Symptom

An MCP server whose `env` or `headers` reference a managed secret may receive the literal
`${NAME}` text on Qwen instead of the value, so authentication to that server fails.

## Steps to Reproduce

1. Attach an MCP server with `env: { API_TOKEN: "!API_TOKEN" }` (or a header) to a Qwen step.
2. Have the server log the value it received.
3. Expected: the secret value. Suspected actual: `${API_TOKEN}` (or whichever placeholder form
   Qwen's config gets).

Not yet run; this needs a behavioural test.

## Root Cause

Qwen expands environment variables only while loading settings files
(`resolveEnvVarsInObject`). `parseMcpConfig` for `--mcp-config` and the stdio transport do not
expand them, in either 0.15.5 or 0.25.3. If ctrlyoke relies on the CLI to expand a placeholder
for Qwen, the placeholder passes through.

## Suggested Fix

Confirm which form `transformSecretMap` emits for Qwen. If it is a placeholder, inject the values
into the spawned process environment and reference them in a form Qwen expands, or pass resolved
values in the inline config (it is process-local), keeping them out of logs.
