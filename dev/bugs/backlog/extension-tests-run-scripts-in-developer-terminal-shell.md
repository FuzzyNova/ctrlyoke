# Extension tests run script fixtures in the developer's `terminal.shellExecutable`

- **Found:** 2026-11-15 by the orchestrator review of session-control Stage 1 (`npm test` on a
  machine whose `~/.ctrlyoke/settings.json` sets `terminal.shellExecutable: "pwsh.exe"`)
- **Area:** `src/test/integration/cli-interactive-output.integration.test.ts`,
  `src/test/integration/cli-interrupt.integration.test.ts`, `src/test/unit/WorktreeManager.test.ts`;
  shell resolution in `src/core/harness/PtyProcessManager.ts` (`terminalSettings.shellExecutable`)
- **Severity:** low

## Symptom

Three extension tests fail on this machine and nowhere else:

- `CLI interactive run output > prints headless script stdout and stderr after the echoed command`:
  "Script exited with code 1". Its script is `echo out-marker; echo err-marker 1>&2`, and
  `pwsh` rejects `1>&2` ("The '1>&2' operator is reserved for future use.").
- `CLI interrupted run > text mode exits with the interrupted code after printing the summary`:
  exit code 1 instead of 5, then `EBUSY` removing the temp directory in `afterEach`.
- `WorktreeManager > runs setup once per run across a named directory switch`:
  "Worktree setup failed … [eval]:1 require('fs').appendFileSync(\ ^ Expected unicode escape".
  The setup command uses cmd-style `\"` escaping, which pwsh passes through literally.

## Steps to Reproduce

1. Set `"terminal": { "shellExecutable": "pwsh.exe" }` in `~/.ctrlyoke/settings.json`.
2. `npm run test:extension -- cli-interactive-output.integration cli-interrupt.integration WorktreeManager`
3. The three tests above fail; with the setting removed they pass.

## Root Cause

Script steps, conditions and worktree setup commands resolve their shell from the per-script
override, then the user's `terminal.shellExecutable`, then platform auto-detect. The tests set
`CTRLYOKE_HOME` for run state, but user settings are still read from the real `~/.ctrlyoke`
(`os.homedir()`, as `.github/copilot-instructions.md` notes for the dev host). So the fixtures,
written for the platform default shell, run in whatever shell the developer configured.

## Suggested Fix

Isolate user settings in these tests: point the settings home at a temp directory for the CLI
child processes and the in-process config service (or pin the shell on each fixture with its
`shell` field). Prefer one shared helper so new script-running tests get the isolation by
default.
