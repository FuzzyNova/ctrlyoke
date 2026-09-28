# A missing harness executable makes the CLI exit 1, not the documented 3

- **Found:** 2026-09-27 by the long-running bug-fix workflow final step (claude-cli, helper agent)
- **Area:** `src/cli.ts` (`getExitCode`), `src/core/harness/shared/CliTransportCoordinator.ts`, `src/core/HarnessIntegration.ts`
- **Resolution:** fixed in this commit

## Symptom

`docs/cli/ci.md` (~59-64) says exit code 3 means "harness CLI could not be found", and the harness
tests treat exit 3 as "skip". With the harness binary absent from PATH:

`PATH="<node>:<pwsh>:<git>:/c/Windows/System32:/c/Windows" node out/cli.js run -p hello -H codex-cli --headless --json`

exits **1** with `error.message: "Failed to send prompt"`. The session log shows `spawn codex ENOENT`.
The same happens for `claude-cli` from a workflow file.

## Steps to Reproduce

1. Remove a harness binary from PATH.
2. Run `ctrlyoke run -p hello -H <that harness> --headless --json`.
3. It exits 1 with a generic message instead of exiting 3.

## Root Cause

`CliTransportCoordinator` (`~603-608`) catches the `spawn … ENOENT`, logs it and returns `false`.
`HarnessIntegration` (`~1185-1186`) then records the default reason "Failed to send prompt", so the
step error never contains "not found"/"enoent". `getExitCode` (`src/cli.ts:~2624-2650`) picks the
exit code by matching those substrings in the error text, so it falls through to 1.

## Suggested Fix

Carry a typed failure kind (e.g. harness-not-installed) from the spawn failure into the step result /
`lastFailureReason`, and have `getExitCode` map that kind to 3 rather than matching error strings.
Ideally, replace the substring heuristic with typed failure kinds for timeout too, so a message like
"credentials not found" can't be misread as exit 3. Tests: a spawn ENOENT gives exit 3, and a
generic failure whose text contains "not found" gives exit 1.
