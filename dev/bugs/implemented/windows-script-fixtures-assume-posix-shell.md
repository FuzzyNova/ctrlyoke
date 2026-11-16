# Script fixtures in three extension tests only work in a POSIX shell, so they fail on Windows

- **Found:** 2026-11-15 by the orchestrator review of session-control Stage 1 (`npm test` on
  Windows 11 with PowerShell 7 installed)
- **Area:** `src/test/integration/cli-interactive-output.integration.test.ts`,
  `src/test/integration/cli-interrupt.integration.test.ts`, `src/test/unit/WorktreeManager.test.ts`;
  shell resolution in `src/core/harness/PtyProcessManager.ts` (`resolveShellInvocation`,
  `resolveWindowsShell`)
- **Resolution:** fixed in this commit

## Symptom

Three extension tests fail on Windows:

- `CLI interactive run output > prints headless script stdout and stderr after the echoed command`:
  "Script exited with code 1". Its script is `echo out-marker; echo err-marker 1>&2`.
- `CLI interrupted run > text mode exits with the interrupted code after printing the summary`:
  exit code 1 instead of 5, then `EBUSY` removing the temp directory in `afterEach`.
- `WorktreeManager > runs setup once per run across a named directory switch`:
  "Worktree setup failed … [eval]:1 require('fs').appendFileSync(\ ^ Expected unicode escape".
  The setup command uses `\"` escaping inside a double-quoted `node -e` argument.

## Steps to Reproduce

1. On Windows, `npm run test:extension -- cli-interactive-output.integration cli-interrupt.integration WorktreeManager`.
2. The three tests above fail.
3. The first case reproduces outside the suite: `node out/cli.js run <workflow with that script> --headless`
   fails the same way with a clean `HOME`/`USERPROFILE`, so it does not depend on the developer's
   settings.

## Root Cause

On Windows, with no `shell` field and no `terminal.shellExecutable`, scripts run in `pwsh.exe`
when it is on `PATH`, otherwise `powershell.exe` (`resolveWindowsShell`). Neither accepts the
fixtures' syntax: PowerShell 7 and Windows PowerShell 5.1 both reject `1>&2` ("The '1>&2'
operator is reserved for future use."), and PowerShell does not unescape `\"` the way the setup
command expects. `cmd` would accept `1>&2` but treats `; echo …` as literal text. So the
fixtures assume `sh`/`bash` semantics. The CLI output test was added on 2026-11-09, after the
last recorded green Windows `npm test` (2026-10-31), which is consistent with it never having
passed on Windows.

Ruled out: the developer's `terminal.shellExecutable: "pwsh.exe"`. Auto-detect picks the same
shell, and the repro above fails without it.

## Suggested Fix

Make each fixture portable or pin its shell:

- Write the scripts as `node -e` programs whose quoting survives every shell, or pin
  `shell: "bash"` on the fixture and skip when bash is unavailable.
- For the stdout/stderr case, emit both streams from one `node -e` that writes to
  `process.stdout` and `process.stderr`.
- For the worktree setup command, build it with the same quoting helper production uses for
  the resolved shell, or call a small script file.

Keep at least one case that runs through the platform default shell on Windows, so shell
resolution stays covered.

## Fix

- The stdout/stderr case now runs one `node -e` that calls `console.log` and `console.error`,
  still through the platform default shell, so it keeps covering shell resolution.
- The worktree setup command puts the counter path in a single-quoted JS string inside the
  double-quoted argument, the quoting every other setup fixture in that file already uses.
- The interrupt case was misdiagnosed: its script runs fine in PowerShell. Node cannot deliver
  SIGINT to another process on Windows; `child.kill("SIGINT")` calls `TerminateProcess`, so the
  CLI exits with code 1 without running its shutdown path, and its script grandchild outlives
  it holding the temp directory (the `EBUSY`). The suite is skipped on Windows; the shutdown
  sequence itself is covered on every platform by `SignalShutdown.test.ts`. The other two
  interrupt cases failed the same way but never ran, because the `afterEach` failure aborted
  the suite.
