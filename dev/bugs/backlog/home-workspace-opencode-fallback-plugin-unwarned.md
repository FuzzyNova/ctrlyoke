# Home directory as workspace: OpenCode fallback plugin lands in `~/.opencode/plugin` without a warning

- **Found:** 2026-11-23 by claude-cli, reviewing ctrlyoke run from the home directory
- **Area:** `src/core/harness/opencode/OpenCodeHarnessAdapter.ts`
- **Severity:** low

## Symptom

When OpenCode cannot load ctrlyoke's completion plugin from its external path, ctrlyoke copies
the plugin into `<workspace>/.opencode/plugin/`. In the home directory that is
`~/.opencode/plugin/`. OpenCode looks for `.opencode` folders in every parent directory of its
working folder, so while the files exist every OpenCode session in any project under the home
directory loads ctrlyoke's plugin.

Other workspace-located harness config written for a step in the home directory produces a
warning (`COMPATIBILITY_DIAGNOSTIC_CODES.HOME_WORKSPACE_USER_CONFIG`, from
`src/core/harness/shared/HomeWorkspaceConfigDiagnostic.ts`). This one does not, because it is not
a `PreparedMutation` in the execution plan.

## Steps to Reproduce

1. Open the home directory as the ctrlyoke workspace.
2. Force the fallback, for example by making the external plugin path fail
   `pluginPathIsReadable`'s probe in a way that still allows the copy.
3. Run an OpenCode step. `~/.opencode/plugin/ctrlyoke-completion-hook.ts` is written, with only a
   `Log.warn` and no output-pane warning.

## Root Cause

`deployCompletionPluginFallback` (`src/core/harness/opencode/OpenCodeHarnessAdapter.ts:1207-1235`)
writes files directly at launch time. `ExecutionPlanBuilder` therefore never sees them, and they
get no `workspaceHarnessConfig` tag.

## Suggested Fix

Plan the fallback as a `PreparedMutation` with `workspaceHarnessConfig: true`, so the existing
home-directory diagnostic covers it in both dry run and real runs. If it has to stay a late
fallback, report the same diagnostic through the integration's user-feedback sink when
`isUserHomeWorkspace(workspaceRoot)` is true.
