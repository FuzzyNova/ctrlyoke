# Qwen hooks containing `"` run in cmd.exe instead of bash when ctrlyoke starts from Git Bash

- **Found:** 2026-11-01 by bug-hunt final step (claude-cli)
- **Area:** `src/core/harness/shared/UserHookEnvironment.ts`
- **Severity:** medium

## Symptom

Since ~1c923d37e, every `qwen-cli` hook whose command contains `"` is wrapped
in `ctrlyoke-hook-run.js` on Windows. The launcher runs the command with
`shell: true`, which means cmd.exe. Qwen itself uses `bash -c` when started
from Git Bash, so a hook that worked before the change now fails there.
Example: `./scripts/notify.sh "step done"` with `MSYSTEM=MINGW64`, which is
set for the `ctrlyoke` CLI, or for VS Code started with `code .` from Git
Bash. It now fails with `'.' is not recognized as an internal or external
command`. Bash syntax (`$VAR`, `VAR=x cmd`) breaks the same way.

## Steps to Reproduce

1. On Windows, start ctrlyoke from Git Bash (`MSYSTEM=MINGW64` in the
   environment).
2. Give a qwen-cli step the hook `./scripts/notify.sh "step done"`.
3. `needsUserHookLauncher(hooks, "qwen-cli")` returns `true`, the command
   is rewritten to `node …/ctrlyoke-hook-run.js <env> hook-0 default <b64>`,
   and the launcher's shell resolves to `cmd.exe`, so the hook fails.

## Root Cause

`harnessBreaksQuotedHookCommands` (`UserHookEnvironment.ts` around lines
36–40) returns true for every win32 Qwen launch. Its own doc comment says
Qwen only mangles quotes "unless it was itself started from Git Bash", but
the code never checks. In Qwen Code 0.26.4, `getShellConfiguration` picks
`bash -c` when `MSYSTEM` starts with `MINGW`/`MSYS` or `TERM` contains
`msys`/`cygwin`, and PowerShell when `ComSpec` is `powershell.exe`/`pwsh.exe`.
`resolveHookShell` (around line 189) passes `default` for Qwen in every case.
That breaks the rule from
`dev/bugs/implemented/hook-launcher-changes-shell-and-orphans-on-timeout.md`
that the launcher must run hooks in the harness's own shell.
`docs/workflows/hooks.md` says such harnesses use their default shell.

## Suggested Fix

Single-source a helper that mirrors Qwen's shell choice from `process.env`
(Git Bash → bash, PowerShell ComSpec → powershell, otherwise cmd). Use it so
that:

- `harnessBreaksQuotedHookCommands` only wraps when Qwen would actually use
  cmd.exe;
- `resolveHookShell` passes `bash` for Qwen under Git Bash, so hooks that
  carry `env` (which always go through the launcher) also keep bash.

Add tests to `src/test/unit/UserHookEnvironment.test.ts`. Stub
`MSYSTEM=MINGW64` and assert that a quoted hook without `env` stays
unwrapped and that an env-bearing hook gets the `bash` shell. Restore
`process.env` and `process.platform` in teardown.
