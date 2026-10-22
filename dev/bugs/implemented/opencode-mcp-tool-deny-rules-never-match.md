# OpenCode per-server MCP tool deny rules never match

- **Found:** 2026-10-21 by a research subagent (OpenCode minimum-version review), from OpenCode source (`mcp/index.ts`, `session/tools.ts`)
- **Area:** `src/types/ToolPermissionUtils.ts` (`mergeServerDeniedTools`), `src/core/harness/opencode/OpenCodeToolPermissionMapper.ts`
- **Resolution:** fixed in this commit

## Symptom

A tool denied on a workflow MCP server (an MCP server's `deniedTools`) is still callable on
OpenCode, although the compatibility matrix marks per-server tool filtering as supported.

## Steps to Reproduce

1. Attach an MCP server with a denied tool to an OpenCode step.
2. Ask the model to call that tool.
3. Expected: OpenCode refuses it. Suspected actual: the call succeeds.

Confirmed with the OpenCode 1.19.4 harness case in
`src/test/harness/inline-config.harness.test.ts`.

## Root Cause

`mergeServerDeniedTools()` produces permission keys shaped `mcp__<server>__<tool>`. OpenCode names
MCP tools `<server>_<tool>`, so the generated permission rules never match a real tool name.

## Resolution

`mergeServerDeniedTools()` now accepts a provider-owned formatter. OpenCode emits permission keys
using its `<server>_<tool>` convention and sanitizes characters outside letters, digits, `_`, and
`-` to `_`. Other harnesses retain the existing `mcp__<server>__<tool>` format. OpenCode 1.19.4's
live harness case confirmed the denied tool call is refused, so the exact filtering declaration
remains unchanged.
