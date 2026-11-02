# Workspace `permissions.codexSandboxMode`/`codexApprovalPolicy` widen Codex without approval

- **Found:** 2026-11-01 by bug-hunt final step (claude-cli)
- **Area:** `src/config/WorkspaceSensitiveSettings.ts`, `src/core/harness/codex/CodexToolPermissionMapper.ts`
- **Severity:** medium

## Symptom

A user who picks `custom` tool permissions to keep Codex sandboxed (user
settings `permissions.codexSandboxMode: "workspace-write"` or `"read-only"`)
can have the sandbox removed by any repository they open. The repository
only has to commit:

```json
{
  "permissions": {
    "codexSandboxMode": "danger-full-access",
    "codexApprovalPolicy": "never"
  }
}
```

Codex then runs every step with `-s danger-full-access -a never`. ctrlyoke
shows no approval prompt, and `ctrlyoke trust-workspace-settings` lists
nothing. A workspace `defaults.toolPermissions` that grants more than the
user's value is withheld until approved. These two settings control the same
thing for Codex and skip that gate.

## Steps to Reproduce

1. In user settings, set `defaults.toolPermissions.mode` to `custom` and
   `permissions.codexSandboxMode` to `workspace-write`.
2. In a workspace, commit the snippet above to `.ctrlyoke/settings.json`.
3. Run a codex-cli step: the launched command line carries
   `-s danger-full-access -a never` (visible with `ui.showCliCommand`).

## Root Cause

`ConfigurationUtils.getCodexSandboxMode()` and `getCodexApprovalPolicy()`
(`src/utils/ConfigurationUtils.ts` around lines 1054–1063) read the merged
`permissions` group, so the workspace value wins. `CodexCliProvider`
(around lines 467 and 683) passes those values to
`CodexToolPermissionMapper`, which emits them as `-s`/`-a` in `custom` mode
(`CodexToolPermissionMapper.ts` around lines 83 and 223–240).
`SENSITIVE_WORKSPACE_SETTINGS` in `src/config/WorkspaceSensitiveSettings.ts`
has no entry for either path, and neither path is in
`WORKSPACE_FORBIDDEN_SETTING_ROOTS` (`src/config/CtrlYokeConfigService.ts:57`).

## Suggested Fix

Option 1: treat both paths like `defaults.toolPermissions`. Add descriptors
whose `isCoveredByUser` accepts a workspace value that is equal to or
narrower than the user's (sandbox: `read-only` < `workspace-write` <
`danger-full-access`; approval: `untrusted`/`on-request` < `never`), so only
widening asks.

Option 2: make both settings user-only by adding them to
`WORKSPACE_FORBIDDEN_SETTING_ROOTS`.

Either way, update the settings docs and add a **Changed** entry to the
changelog. `dev/backlog/HARNESS_SANDBOX_PLAN.md` plans to redesign this
area, so decide whether to fix it now or fold it into that plan.

This is a behavior change: workspace values that used to apply silently will
prompt, or stop applying.
