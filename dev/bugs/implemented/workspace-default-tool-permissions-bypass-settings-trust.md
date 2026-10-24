# Workspace `defaults.toolPermissions` widens harness permissions without approval

- **Found:** 2026-10-23 by the "end condition okay to add" step (claude-cli)
  while working out the MCP step-control security boundary
- **Area:** `src/config/WorkspaceSensitiveSettings.ts`,
  `src/config/CtrlYokeConfigService.ts`, `src/utils/ConfigurationUtils.ts`
- **Resolution:** fixed in this commit

## Resolution notes

`defaults.toolPermissions` is now a `value`-shaped entry in
`SENSITIVE_WORKSPACE_SETTINGS`. Descriptors gained an optional
`isCoveredByUser(workspaceValue, userValue)` check, which defaults to the old
identical-value rule. For tool permissions it layers the workspace value over
the user's effective value the way the config merge does, then asks
`isToolPermissionConfigNoWiderThan` (`src/types/ToolPermissionUtils.ts`)
whether the result grants anything more. Only a wider value becomes a trust
request. The approval summary leads with the requested mode, because the
generic sorted JSON put `mode` last, where a long allow-list truncated it.

## Symptom

A workspace's `.ctrlyoke/settings.json` can set `defaults.toolPermissions`,
for example `{ "mode": "dangerouslyAllowAll" }`, and every step in that
workspace that doesn't set its own `toolPermissions` runs with it. ctrlyoke
never asks the user first.

Workspace settings that can make ctrlyoke launch a program already need a
user-local approval before they apply: the terminal shell,
`defaults.additionalArgs`, `defaults.hooks`, stdio `defaults.mcpServers`, and
the default end/pre-conditions. `defaults.toolPermissions` belongs in the same
class. `defaults.additionalArgs` is gated precisely because it can carry
`--dangerously-skip-permissions`, but `dangerouslyAllowAll` produces the same
flag through the permission mapper with no gate.

There are two ways in:

- **A cloned or compromised repository** ships the setting. The user opens the
  workspace and runs any workflow, and its steps run unrestricted.
- **A running agent writes the file.** A sandboxed or edit-only agent, for
  example codex-cli in workspace-write, can edit `.ctrlyoke/settings.json`
  because it's inside the workspace. Settings are re-read, so later steps in the
  same run start with wider permissions than the author chose. This is the
  prompt-injection path the `edit_step` `additionalArgs` fix
  (`dev/bugs/implemented/mcp-edit-step-additional-args-can-widen-harness-permissions.md`)
  closed for MCP, reached through the filesystem instead.

Confirmed by reading the code; not yet reproduced end to end.

## Steps to Reproduce

1. User settings: leave `defaults.toolPermissions` at its shipped default
   (`allowAll` with the default allow-list).
2. In a workspace, write `.ctrlyoke/settings.json`:
   `{ "defaults": { "toolPermissions": { "mode": "dangerouslyAllowAll" } } }`.
3. Run a workflow whose steps don't set `toolPermissions`.
4. No trust prompt appears, and the harness launches with its bypass flag (for
   example claude-cli's `--dangerously-skip-permissions`).

## Root Cause

`SENSITIVE_WORKSPACE_SETTINGS` (`src/config/WorkspaceSensitiveSettings.ts:75`)
lists the gated paths, and `defaults.toolPermissions` isn't one of them.
`CtrlYokeConfigService.getWorkspaceSettings()` therefore passes the value
through unfiltered. `getDefaultCliToolPermissionConfig()`
(`src/utils/ConfigurationUtils.ts:72`) reads it from the merged `defaults`, and
`resolveSpawnToolPermissions()` hands it to the harness's permission mapper.

## Suggested Fix

Reuse the existing workspace-settings trust flow. It already gives the
behavior we want: one batched approval per workspace (`BatchApprovalModal` in
the dashboard, `WorkspaceSettingsTrustPrompt.ts` in VS Code,
`WorkspaceSettingsTrustCommands.ts`/`CliTrustGate.ts` for the CLI), decisions
fingerprinted and stored user-local, a changed value asked about again, and an
unapproved value withheld so the user's own setting applies.

1. Add a `defaults.toolPermissions` descriptor to
   `SENSITIVE_WORKSPACE_SETTINGS` with the `value` shape.
2. Ask only when the workspace value is **wider** than the user's effective
   value (the user setting, or the shipped default). A workspace that narrows
   permissions, or repeats the user's own value, needs no prompt. Today
   `isSensitive(value)` sees only the workspace value, and the auto-approval
   check is `valuesEqual(workspaceValue, userValue)`. Generalize that to a
   per-descriptor `isCoveredByUser(workspaceValue, userValue)` check that
   defaults to `valuesEqual`.
3. Define "not wider" conservatively, as one helper beside
   `ToolPermissionUtils.ts`: the mode ranks at or below the user's
   (`custom` < `allowAll` < `dangerouslyAllowAll`), every workspace
   `allowedTools` entry is in the user's list, and every user `deniedTools` entry
   is still denied. Treat `none` (pass no flags, defer to the harness's own
   config) as wider unless the user's mode is also `none`. Anything the helper
   can't prove is narrower prompts.
4. The approval summary should name the mode and the added allow / removed deny
   entries, for example "Workspace requests tool permissions:
   dangerouslyAllowAll (yours: allowAll)".
5. Tests: `WorkspaceSensitiveSettings` unit coverage for wider / narrower /
   equal / `none`, a config-service test that an unapproved wider value falls
   back to the user value, and a CLI trust-gate test that noninteractive runs
   fail closed.
6. Note it under **Changed** in `CHANGELOG.md`. A workspace that relied on this
   setting now prompts once.

Out of scope: a workflow file's own `toolPermissions` (prompt or workflow
level) still applies without a prompt. The user deliberately runs that file,
the same way they choose to run `npm test`. A running agent rewriting the
_run's_ copy of the definition is a separate bug:
`dev/bugs/backlog/workspace-mode-run-files-writable-by-sandboxed-agents.md`.
