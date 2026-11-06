# Continue on a stopped run silently does nothing (setup-stop guard keyed on STOPPED)

- **Found:** 2026-11-06 by user (session log `ctrlyoke-1793970250051.log`), diagnosed with claude-cli
- **Area:** `src/core/orchestration/WorkflowStartupPipeline.ts`, `src/core/WorkflowInstance.ts`, `src/core/WorkflowStateMachine.ts`
- **Resolution:** fixed in this commit

## Symptom

On a stopped run, neither the header's **Continue** nor appending a prompt with
**Run Next** started anything. No error or notice appeared. The session log
showed each attempt reaching `[APPEND-DEBUG] Manual resume: Reusing existing
history file`, acquiring the runner lock and releasing it ~9 ms later, with no
`Sending EXECUTION_STARTED` or `Starting workflow execution` line after it.

## Steps to Reproduce

1. Run a workflow and press **Stop** mid-step.
2. Press **Continue**, or type a prompt and use **Run Next**.
3. Nothing runs; the run stays STOPPED.

## Root Cause

`3cfa7a5d2` (runner-lock heartbeat during worktree setup) added a "stopped
during setup" guard after `prepareExecutionWorktree` in
`WorkflowStartupPipeline.prepareWorktreeAndDispatch` that checked
`getAuthoritativeExecutionState() === STOPPED`. In this pipeline the runtime
only becomes RUNNING later, in `WorkflowExecutor.execute()`
(`startExecution()`), so continuing a run that was _already_ STOPPED tripped
the guard every time. The run stayed un-continuable.

The guard itself is needed. Without it, a stop pressed during a long `setup`
is silently undone: `startExecution()` turns STOPPED back into RUNNING and the
stopped step runs anyway. A second problem was also present: `stop()` marked
the never-dispatched current step CANCELLED and advanced past it
(`markInFlightPromptCancelled` / `finalizeCancelledPromptAfterStop`), so the
next Continue would have skipped a step that never ran.

## Fix

- `WorkflowStateMachine.stopRequestCount` counts every `requestStop()`.
  `WorkflowStartupPipeline` snapshots it at construction (one pipeline per
  execution call) and aborts before and after worktree setup only if it
  changed. The paused-run resume path in `WorkflowInstance.resume` uses the
  same comparison.
- `WorkflowInstance.preDispatchStartup` marks a start/resume that has not
  dispatched yet (ended by `beginExecution`). `stop()` in that window, with no
  active target resources, only transitions the runtime to STOPPED: it leaves
  the current step pending and does not advance `currentIndex`.
- A new start waits for any pre-dispatch startup to settle first, so a
  Continue pressed while a stopped startup is still finishing its setup cannot
  interleave with that startup releasing the lock and worktree.
- **Stop kills a running `setup` command.** Pre-conditions, end conditions and
  script steps were already killed through their target's
  `ScriptProcessRunner` in `activeTargetResources`. Setup runs before any
  target exists, so `WorkflowInstance.activeWorktreeSetupRunner` holds its
  runner and `stop()` cancels it. A stop that lands before the process spawns
  skips the spawn. The killed setup then throws out of
  `prepareExecutionWorktree`, and both the startup and resume failure paths
  treat a setup failure after a stop request as the stop, not an error. The
  existing failed-setup handling re-provisions on the next run (a named
  worktree re-runs setup unless the last outcome succeeded; a managed one is
  reclaimed by `reconcileBlockedManagedWorktrees`).
- **The run is RUNNING for the whole setup.** The pipeline announces
  continuations with `EXECUTION_STARTED` before setup too (fresh starts
  already were), and calls `startExecution()` before setup, so the executor's
  own call is a no-op. This is not cosmetic. `stopAtRun`/`pauseAtRun` resolve
  only instances in `WorkflowOrchestrator.instances`, and a stopped run's
  instance sits in `retiredInstances` until a RUNNING transition promotes it.
  A UI-only flip would have offered a Stop that failed with "The requested run
  is no longer executing". Terminal reuse is only known once the integration
  exists, so a continuation that reuses a live terminal is re-announced after
  setup with `reusesRunningTerminal`. No setup ran in that case, so no setup
  output is disturbed. A Pause during setup is confirmed at the post-setup
  boundary; the run keeps its reservations and Resume dispatches through the
  paused-run resume path.
