# VS Code workflow pickers silently drop git-ignored workflow files

- **Found:** 2026-10-24 by bug-drain review of 9e2691cf2
- **Area:** `src/utils/WorkflowFileDiscovery.ts`, `src/extension.ts`, `src/platform/VsCodeDashboardHostActions.ts`
- **Resolution:** fixed in this commit

## Symptom

Since 9e2691cf2, the VS Code "Select prompt file" and Load/Append Workflow quick
picks no longer list workflow files in git-ignored folders, whatever the
`hideGitIgnoredFiles` setting says. Its default, `false`, means show them. This
includes `.prompt.md` files that `PromptFileWriter` saves under
`.ctrlyoke/prompts/`, which ctrlyoke's own generated `.gitignore` ignores
(`WorkspaceInitializer.ts`, around line 61). The CHANGELOG entry only mentions the
hosted picker.

## Root Cause

The VS Code callers of the new async discovery never pass `includeGitIgnored`. The
hosted picker does pass it, from `hideGitIgnoredFiles`.

## Suggested Fix

Pass `includeGitIgnored: !hideGitIgnoredFiles`, read through
`CtrlYokeConfigService`/`ConfigurationUtils` exactly as the hosted path does, from
both VS Code callers. Single-source the option derivation if the hosted server
computes it the same way. Add a unit test that a git-ignored workflow file is
returned when the setting is off. Update the CHANGELOG entry.
