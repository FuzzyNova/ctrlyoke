# OpenCode per-server MCP tool deny rules never match

- **Found:** 2026-10-21 by a research subagent (OpenCode minimum-version review), from OpenCode source (`mcp/index.ts`, `session/tools.ts`)
- **Area:** `src/types/ToolPermissionUtils.ts` (`mergeServerDeniedTools`), `src/core/harness/opencode/OpenCodeToolPermissionMapper.ts`
- **Severity:** high

## Symptom

A tool denied on a workflow MCP server (an MCP server's `deniedTools`) is still callable on
OpenCode, although the compatibility matrix marks per-server tool filtering as supported.

## Steps to Reproduce

1. Attach an MCP server with a denied tool to an OpenCode step.
2. Ask the model to call that tool.
3. Expected: OpenCode refuses it. Suspected actual: the call succeeds.

Found by reading the code; confirm with a `test:harness` case. The existing evidence
(`inline-config.harness.test.ts`) only checks that the MCP server connects.

## Root Cause

`mergeServerDeniedTools()` produces permission keys shaped `mcp__<server>__<tool>`. OpenCode names
MCP tools `<server>_<tool>`, so the generated permission rules never match a real tool name.

## Suggested Fix

Let the OpenCode mapper rewrite server-denied tools to OpenCode's `<server>_<tool>` naming, using
`mergeServerDeniedTools`' existing `normalizeServerId` seam or a provider-owned tool-name
formatter. Until it is verified, downgrade OpenCode's `mcp.perServerToolFiltering` declaration so
the matrix doesn't promise enforcement.
