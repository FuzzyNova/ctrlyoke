# SIGKILL escalation is skipped once another process becomes current on the same CliProcessManager

- **Found:** 2026-09-30 by the long-running bug-fix workflow final step (claude-cli, helper agent, esbuild script with injected killProcessTree)
- **Area:** `src/utils/CliProcessManager.ts` (`killGracefully` escalation, `killTimeoutId`, `cleanupProcessState`)
- **Resolution:** fixed in this commit

## Symptom

1. Spawn process A with `timeout: 200`, where A ignores SIGTERM.
2. A times out and gets SIGTERM.
3. Spawn process B on the same manager.
4. Wait 4s.

A is never sent SIGKILL: the recorded kill calls are only `SIGTERM->A`. When A finally closes,
`cleanupProcessState` → `clearKillTimeout()` also cancels B's escalation timer, if it has one.

This is reachable because `WorkflowInstance.getScriptProcessRunner` caches one runner (one
manager) per target and reuses it across steps and retries. A timed-out script followed by the next
or retried script can therefore leave an orphaned process tree. f6b8d670d made routine
`disposeProcess()` graceful and relies on this escalation ("Keep the child current until close so
the graceful kill's escalation timer can still force-kill the tree"), which widens the exposure.

## Steps to Reproduce

The repro is a unit test that injects `killProcessTree` into `CliProcessManager` and follows the
sequence above, asserting a SIGKILL for A after the escalation delay.

## Root Cause

The escalation callback is guarded by `this.currentProcess === child` (~l.403). There is also a
single shared `killTimeoutId` that any process's cleanup clears.

## Suggested Fix

Track escalation timers per child (`Map<ChildProcess, NodeJS.Timeout>`). Guard escalation on the
child still being alive (`child.exitCode === null && child.signalCode === null`) instead of on
`currentProcess`, and on close clear only that child's timer. Add unit tests for both the
orphan-A case and the "A's close doesn't cancel B's timer" case.
