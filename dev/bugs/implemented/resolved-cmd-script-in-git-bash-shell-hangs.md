# A resolved `.cmd` condition script with shell syntax hangs under a Git Bash shell on Windows

- **Found:** 2026-10-10 by claude-cli bug-hunt final step (review of ~d3a822cfb, reproduced on Windows with a scratch `npx tsx` script)
- **Area:** `src/core/EndConditionEvaluator.ts` (`buildResolvedScriptShellCommand`)
- **Resolution:** fixed in this commit

## Symptom

On Windows, a condition with `shell: bash` (Git Bash) whose script names a
`.cmd` file found through the documented lookup and uses shell syntax, e.g.
`script: c.cmd q && echo SECOND`, now hangs until the script timeout. Before
~d3a822cfb, `bash -c "plain/c.cmd q && echo SECOND"` worked.

## Steps to Reproduce

1. Put `.ctrlyoke/c.cmd` in a workspace.
2. Evaluate `{ script: "c.cmd q && echo SECOND", shell: "bash" }` on Windows.
3. The condition times out.

## Root Cause

For the CMD interpreter in a non-cmd, non-PowerShell shell,
`buildResolvedScriptShellCommand` renders the POSIX-quoted invocation
`'cmd' '/d' '/s' '/c' '"…c.cmd"'`. MSYS/Git Bash rewrites the `/d`, `/s` and
`/c` arguments as drive paths, so `cmd` starts interactively and waits for
input.

## Suggested Fix

For the CMD interpreter in a POSIX shell, emit only the quoted resolved path
(Git Bash runs `.cmd` files through cmd itself), or use `cmd //d //s //c` for
MSYS. Windows-only test in `src/test/endConditionEvaluator.test.ts` with
`shell: "bash"` (skip when bash is unavailable).
