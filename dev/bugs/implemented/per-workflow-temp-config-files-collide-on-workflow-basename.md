# All workflows in a workspace share one MCP config file because its name comes from the working file's basename, which is always "workflow"

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/core/harness/shared/CliMcpConfigGenerator.ts`
- **Resolution:** fixed in this commit

## Symptom

When two workflows run at the same time in one execution root (no worktree) on the same harness, both write the same MCP config file: `.ctrlyoke/temp/mcp-config-claude-workflow.json` for claude-cli, `.ctrlyoke/temp/mcp-config-workflow.json` for copilot-cli.

- If their step launches overlap, one workflow's CLI can start with the other workflow's `CTRLYOKE_WORKING_FILE`. Its ctrlyoke MCP tools (`append_step`, queue edits, coordination attestation) then act on the other run.
- When one workflow finishes, its cleanup deletes the shared file. Another workflow whose CLI is launching at that moment loses the file its `--mcp-config` argument points at. Depending on the harness, that CLI then fails to start or starts without the ctrlyoke MCP tools.

## Steps to Reproduce

1. In one workspace with ctrlyoke MCP enabled, create two different workflows, A and B, both on claude-cli. Use no managed worktree, so both share one execution root.
2. Start A and B at almost the same time, so their first steps launch within a second or two of each other. Headless mode makes this easier, because each step spawns a new process and rewrites the config.
3. Look in `.ctrlyoke/temp/`: there is only one `mcp-config-claude-workflow.json`. Its `CTRLYOKE_WORKING_FILE` names whichever run wrote it last.
4. If B's write lands after A's write but before A's Claude process reads the file, A's ctrlyoke MCP server is pinned to B's run file. An `append_step` call from A's agent then appends to B's run.
5. Alternatively, let A finish (and its PTY end) while B's step is starting. A's `cleanupWorkflowArtifacts` deletes the shared file, and B's CLI starts with a `--mcp-config` path that no longer exists.
6. To confirm the shared name directly: `CliMcpConfigGenerator.getConfigFilePath('<runs>/k1/run-1/workflow.ctrlyoke.json', root, 'mcp-config-claude')` and the same call with `'<runs>/k2/run-9/workflow.ctrlyoke.json'` both return `<root>/.ctrlyoke/temp/mcp-config-claude-workflow.json`.

## Root Cause

`src/core/harness/shared/CliMcpConfigGenerator.ts:334` takes the filename suffix from `path.basename(workingFilePath, ".ctrlyoke.json")`. That assumes the old flat working-file names such as `1774891046-my-workflow.ctrlyoke.json`. Working files are now always `<runsRoot>/<workflowKey>/run-<ts>/workflow.ctrlyoke.json` (`WORKING_FILE_NAME`, `src/utils/WorkflowPaths.ts:23`), so the suffix is `workflow` for every run.

These callers use the colliding path for both the write and the cleanup:

- `ClaudeCliProvider.getMcpConfigFilePath` (`src/core/harness/claude/ClaudeCliProvider.ts:910-919`), which is written at `:884-898`. The comment at `:884` says the name is meant to be "unique per execution to avoid parallel workflow collisions".
- `CopilotCliProvider.getMcpConfigFilePath` (`src/core/harness/copilot/CopilotCliProvider.ts:1150-1159`), which is written at `:1124-1136`. It carries the same comment.
- `CliIntegration.cleanupWorkflowArtifacts` / `cleanupWorkflowArtifactsStrict` (`src/core/harness/CliIntegration.ts:2067-2105`) delete that path.

The file's env pins `CTRLYOKE_WORKING_FILE`, and `src/mcp-server.ts` uses it to choose the run (`:598` for attestation, `:1891` in `requireRunAddress`). So whichever run last wrote the file owns every MCP server that reads it.

The unit test `src/test/unit/CliMcpConfigGenerator.test.ts:230-241` asserts the colliding name (`mcp-config-workflow.json`), so the suite does not catch this.

Other filename builders make the same assumption:

- `CopilotCliProvider.buildHookFileName` (`CopilotCliProvider.ts:968-981`), whose comment still cites `1774891046-my-workflow.ctrlyoke.json`.
- `CopilotCliProvider.buildOtelFileName` (`CopilotCliProvider.ts:991-1003`), which copies that logic.
- `ClaudeCliProvider.buildHookSettingsFileName` (`ClaudeCliProvider.ts:591-603`).

These produce `ctrlyoke-workflow-p<N>.json`, `ctrlyoke-otel-workflow-p<N>.jsonl` and `claude-hook-settings-workflow-p<N>.json` for every workflow, so concurrent workflows at the same prompt index overwrite each other's hook and OTel files.

## Suggested Fix

Build the suffix from something unique per run, not from the basename. Either:

- use the workflowKey plus the run directory name, sanitized: `path.basename(path.dirname(path.dirname(p)))` + `-` + `path.basename(path.dirname(p))`; or
- use a short stable hash (for example the first 12 hex characters of a sha256) of the normalized absolute working-file path.

Put this in one helper, for example `WorkflowPaths.runArtifactStem(workingFilePath)`. Use it in `CliMcpConfigGenerator.getConfigFilePath`, `CopilotCliProvider.buildHookFileName`, `CopilotCliProvider.buildOtelFileName` and `ClaudeCliProvider.buildHookSettingsFileName`, so the write and cleanup paths keep matching. Update the stale comments that cite `<ts>-<name>.ctrlyoke.json`.

Change `CliMcpConfigGenerator.test.ts:230-241` to assert a run-specific name. Add a test showing that two working files in different run directories produce different config paths.
