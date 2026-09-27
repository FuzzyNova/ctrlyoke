# Managed-worktree `setup` runs through Node's default shell (cmd.exe on Windows), not the shell used by every other script

- **Found:** 2026-09-27 by the long-running bug-fix workflow final step (claude-cli, helper agent)
- **Area:** `src/core/orchestration/WorktreeManager.ts` (`DefaultWorktreeSetupRunner`), `src/core/WorkflowInstance.ts`
- **Severity:** medium

## Symptom

On Windows, script steps and pre/end conditions run in PowerShell (or `terminal.shellExecutable`),
but `worktree.setup` runs in `cmd.exe`. In a git repo:

```yaml
worktree:
  mode: managed
  setup: "Write-Output SETUP_{{who}}; Set-Content -Path setup-marker.txt -Value {{who}}"
steps:
  - type: script
    script: "Write-Output hi"
```

`ctrlyoke run w.ctrlyoke.yaml --headless --var who=cli` fails with
`Worktree setup failed … 'Write-Output' is not recognized as an internal or external command`, while
the script step in the same file would run fine in pwsh. A cmd-syntax setup
(`echo {{who}}> setup-marker.txt`) passes. On POSIX the setup gets `/bin/sh` rather than the
configured shell. The `--dry-run` preview doesn't show the setup command at all.

## Steps to Reproduce

1. In a git repo on Windows, create the workflow above.
2. Run it headless. Setup fails with the cmd.exe error.

## Root Cause

`DefaultWorktreeSetupRunner` (`WorktreeManager.ts:~245-263`) and the setup call in
`WorkflowInstance.ts` (`~4226-4233`) use `processRunner.run({ argv: [command], viaShell: true })`,
i.e. Node's `shell: true` (ComSpec / `/bin/sh`). Script steps go through `resolveShellInvocation()`
(`WorkflowInstance.ts:~3638`), and `core.instructions.md` says not to use Node's `shell: true`.

## Suggested Fix

Route setup through `resolveShellInvocation(command)` exactly as script steps do, so it honours the
same default shell and `terminal.shellExecutable`. Single-source the call if both setup sites stay.
Optionally include the setup command in the dry-run preview. Tests: the setup runner builds the same
argv as a script step for the same command and settings.
