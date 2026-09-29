# A script killed by any signal is reported as a user cancellation

- **Found:** 2026-09-29 by bug-hunt final step (claude-cli)
- **Area:** `src/core/orchestration/ScriptProcessRunner.ts`, `src/utils/CliProcessManager.ts`, `src/core/WorkflowExecutor.ts`
- **Severity:** medium

## Symptom

Since 8b119e21e, a script step or condition whose process dies from a signal
ctrlyoke did not send (the OOM killer's SIGKILL, a test runner that segfaults,
`process.kill(process.pid, 'SIGKILL')`) is recorded as **cancelled**, not failed.
The step skips `onFail`, retries and `errorBehavior`, and the exit code is
dropped from the output and verdict. On POSIX `sh -c` usually `exec`s the last
command, so the script is the direct child and Node reports its `signal`.
Windows reports `signal: null`, so it isn't affected.

## Steps to Reproduce

1. On Linux/macOS, run a workflow with a script step
   `node -e "process.kill(process.pid,'SIGKILL')"` and `onFail: continue` (or
   `errorBehavior: retry`).
2. Observed: the step is CANCELLED and the workflow stops as if the user
   cancelled it.
3. Expected: a FAILED step handled by the configured failure policy.

## Root Cause

`CliProcessManager` resolves `terminationSignal: signal ?? this.requestedKills.get(child)`
(`CliProcessManager.ts` ~218), so an OS-delivered signal is indistinguishable
from a ctrlyoke-requested kill. `ScriptProcessRunner.run()` then maps any
`terminationSignal` to `{ cancelled: true }` (~123-133), and
`WorkflowExecutor`'s `if (evalResult.cancelled)` branch treats it as
cancellation.

## Suggested Fix

Expose whether the kill was requested (e.g. a `terminatedByManager` flag on the
spawn result, as `spawnInteractive` already does via `requestedKills.has(child)`),
and set `cancelled` only when ctrlyoke requested the kill. An unrequested
signal death should stay a failure (a non-zero exit, with the signal in the
error text). Add a unit test with a stubbed spawn result carrying a `signal`
but no requested kill.
