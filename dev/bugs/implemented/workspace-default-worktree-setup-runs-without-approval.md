# Workspace `defaults.worktree.setup` runs a command without approval

- **Found:** 2026-11-01 by bug-hunt final step (claude-cli)
- **Area:** `src/config/WorkspaceSensitiveSettings.ts`, `src/core/orchestration/WorktreeManager.ts`
- **Resolution:** fixed in this commit

## Symptom

A repository can commit this in `.ctrlyoke/settings.json`:

```json
{ "defaults": { "worktree": { "mode": "managed", "setup": "<any command>" } } }
```

Every workflow the user runs in that workspace that has no root `worktree`
value then creates a managed worktree and runs the setup command through
`ScriptProcessRunner`. This includes the user's own workflows and the built-in
templates. ctrlyoke never asks first. Every other workspace setting that can
launch a program is withheld until the user approves that exact value: the
terminal shell, `additionalArgs`, hooks, stdio MCP servers, end/pre-conditions
and tool permissions wider than the user's.

## Steps to Reproduce

1. In a git workspace, write the snippet above to `.ctrlyoke/settings.json`
   with `setup` set to something observable (e.g.
   `node -e "require('fs').writeFileSync('pwned.txt','x')"`).
2. Open the dashboard. No "Workspace Settings That Run Programs" prompt
   lists the value, and `ctrlyoke trust-workspace-settings` lists nothing.
3. Run any workflow that omits `worktree` (or `ctrlyoke run` it): the
   managed worktree is created and the setup command runs.

## Root Cause

`SENSITIVE_WORKSPACE_SETTINGS` (`src/config/WorkspaceSensitiveSettings.ts`
around line 150) has no entry for `SETTING_PATHS.DEFAULTS_WORKTREE`
(`src/utils/ConfigurationUtils.ts:147`). As a result,
`ConfigurationUtils.getDefaultWorktree()` returns the merged workspace value
unfiltered. `WorkflowStartupPipeline.resolveWorktree()`
(`src/core/orchestration/WorkflowStartupPipeline.ts` around line 607) and
`WorkflowInstance` (around line 2466) feed that value into worktree
resolution, and `DefaultWorktreeSetupRunner`
(`src/core/orchestration/WorktreeManager.ts:287`) runs `setup` as a shell
script. The settings docs (`docs/reference/settings.md` intro,
`docs/guide/settings.md` around line 70) list the gated settings and do not
mention `defaults.worktree`. The descriptor comment ("Workspace settings that
can make ctrlyoke launch a program") misses this one too.

## Suggested Fix

Add a `SETTING_PATHS.DEFAULTS_WORKTREE` descriptor (shape `VALUE`) whose
`isSensitive` is true only when the value is an object with a non-empty
`setup` string. That way `true`, a branch shorthand, or an object without
`setup` keep applying without a prompt. Add a `summarize` that shows the
setup command. Update the schema description for `defaults.worktree` (it
feeds the generated reference docs: run `npm run schema:update`), the
hand-written list in `docs/guide/settings.md` (which also omits
`defaults.toolPermissions`, though the reference docs and the code gate it)
and the partial
`docs/reference/_partials/settings/intro.md`. Add a **Changed** entry to
`CHANGELOG.md`, since a repository that relied on this now prompts once.
Tests go next to the existing descriptor tests (grep `src/test/unit` for
`DEFAULTS_PRE_CONDITION` / `getWorkspaceSensitiveSettingStates`).

This is a behavior change: workspaces that set a worktree setup command will
see a new approval prompt.
