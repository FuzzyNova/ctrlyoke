# MCP server ignores the run-history location setting when no env handoff arrives

- **Found:** 2026-11-09 by deferred code-smell review, claude-cli
- **Area:** `src/mcp-server.ts` (`initializeMcpStorage`, `runMcpToolCli`), `src/utils/RunHistoryStoragePolicy.ts`
- **Severity:** high (workflow tools unusable in skill mode for workspace-location users)

## Symptom

With `storage.runHistoryLocation: "workspace"` and `execution.ctrlyokeMcpMode:
"skill"`, every workflow tool invoked through
`node mcp-server.js --tool … --workspace … --working-file …` probably fails
with "the attached run file no longer exists". A standalone MCP registration
(no ctrlyoke-generated config) looks in user-scope history in the same way,
but there it only affects `global_status`. This hasn't been reproduced end to
end; it follows from reading the code.

## Steps to Reproduce

1. Set `storage.runHistoryLocation` to `"workspace"` in `.ctrlyoke/settings.json`.
2. Set `execution.ctrlyokeMcpMode` to `"skill"` and run a workflow whose step
   calls a queue tool (for example `add_step`).
3. The tool exits non-zero and reports that the run file is missing.

## Root Cause

`initializeMcpStorage` (`src/mcp-server.ts:2307`) freezes the location from
`process.env.CTRLYOKE_RUN_HISTORY_LOCATION` only. When the variable is unset,
`parseRunHistoryLocation` (`RunHistoryStoragePolicy.ts:58`) returns `user`.
The variable is written only into the generated MCP config env
(`src/core/harness/shared/CliProviderUtils.ts:478-483`). Skill mode doesn't
carry it: `src/templates/skills/ctrlyoke-mcp-tools/SKILL.md` tells the
harness not to rely on environment inheritance. `resolveRun` then rebuilds the
run path from `workspaceRoot` and the frozen `user` location
(`WorkflowPaths.ts:173`), not from `--working-file`. `CTRLYOKE_MAX_STEPS` is
lost the same way, so step limits fall back to their defaults
(`QueueLimitUtils.ts:13`).

The env handoff predates settings loading in the MCP process (f3e15c11a, before
`bootstrapMcpProcess` arrived in 139443134). It is still the right primary
source, because it carries the parent's frozen value. Only the fallback is
missing.

## Suggested Fix

Use the env var when present. Otherwise use
`configService.get("storage").runHistoryLocation`, since settings are already
loaded by `bootstrapMcpProcess` (`mcp-server.ts:2332`). Apply the same
fallback to the max-steps limits. Add an `McpServer.test.ts` case for
`--tool` mode with the workspace location (current tests only use user
scope).
