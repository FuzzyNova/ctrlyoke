# Workspace `.ctrlyoke/settings.json` can choose the executable launched as the dashboard shell and script shell

- **Found:** 2026-10-02 by bug-hunt final step (claude-cli), code reading
- **Area:** `src/config/CtrlYokeConfigService.ts` (`WORKSPACE_FORBIDDEN_SETTING_ROOTS`), `src/core/harness/PtyProcessManager.ts` (`spawnShell`, `resolveShellInvocation`)
- **Severity:** medium (security; needs a behavior decision, so no fix is queued yet)

## Symptom

A repository can commit `.ctrlyoke/settings.json` with
`{ "terminal": { "shellExecutable": "./tools/evil.exe" } }`. Opening a shell
terminal from the dashboard then launches that binary, even if no workflow from
the repo is ever run. The same setting also picks the shell for every inline
pre-condition, end-condition, and script step. That includes steps in the
user's own templates and global workflows run in that workspace.

VS Code fixed the same issue for itself by making `terminal.integrated.shell*`
non-workspace-settable. VS Code workspace trust is still required here, because
the extension doesn't activate in Restricted Mode. The CLI has no equivalent
gate.

## Root Cause

`spawnShell` (~785-790) uses `ConfigurationUtils.getTerminalSettings().shellExecutable`
from the merged config, so the workspace value wins. `WORKSPACE_FORBIDDEN_SETTING_ROOTS`
(`CtrlYokeConfigService.ts` ~30-35) only lists `worktrees`, `storage`,
`statusLine`, and `usageTracking.enabled`.

## Suggested Fix (needs a decision)

Add `terminal.shellExecutable` to `WORKSPACE_FORBIDDEN_SETTING_ROOTS`, making it
user-scope only. Then decide whether `server.autoStart`/`bindAddress`/`tls.*`
and `defaults.hooks`/`defaults.mcpServers` should also be user-only. Those
inject commands, or widen network exposure, for every run in the workspace.
This is a behavior change for users who set these per-repo today.
