# Runner lock and execution lease are not heartbeated during worktree `setup`, so a live run can be reclaimed as stale

- **Found:** 2026-11-01 by bug-hunt final step (claude-cli)
- **Area:** `src/core/orchestration/WorkflowStartupPipeline.ts`, `src/core/WorkflowInstance.ts`, `src/core/orchestration/RunnerLockCoordinator.ts`, `src/git/WorktreeManager.ts`
- **Resolution:** fixed in this commit

## Symptom

A workflow whose `worktree.setup` command runs for more than 30 s (an `npm
install`, for example) holds a runner lock (`runner.json`) and a worktree
execution lease that nothing refreshes while setup runs. Once the heartbeat
is more than 30 s old, both look stale even though the owning process is
alive:

- `ctrlyoke status --json` reports the run as `stale` / `stale-heartbeat`.
- A second workflow targeting the same named worktree reclaims the lease. Its
  `acquireLease` → `readLiveLeases` (`ExecutionRootLeaseManager.ts:181`) unlinks
  the first run's lease, and both runs then execute in the same checkout. The
  first run's later `updateHeartbeat` finds no file and silently returns
  (`ExecutionRootLeaseManager.ts:~299`), so it stays unprotected for the rest
  of the run.
- Another host can reclaim the first run's `runner.json` in the same way.

## Steps to Reproduce

1. Two workflows both declare
   `worktree: { mode: named, name: feat, setup: "node -e \"setTimeout(()=>{},40000)\"" }`.
2. Start workflow A. About 31 s later, while A's setup is still running, start
   workflow B.
3. B takes over the lease and runs in the same worktree as A. During the gap,
   `ctrlyoke status` also shows A as stale.

## Root Cause

`isOwnerStale` (`src/utils/LockSafetyPrimitives.ts:36`) treats an owner as
stale when its PID is dead **or** its heartbeat is older than
`STALE_HEARTBEAT_MS` (30 s), so a live PID doesn't protect it. The start-up
order is:

1. `WorkflowStartupPipeline.ts:832` acquires the runner lock (`ensureRunnerLock`).
2. `WorkflowStartupPipeline.ts:890` calls `prepareExecutionWorktree`, which
   acquires the lease (`WorktreeManager.ts` around `:2469` for named and
   `:3066` for managed) and awaits the user's `setup` (`runSetup`).
3. Only then does `startWorkflowExecution` start the heartbeat
   (`WorkflowStartupPipeline.ts:398`, `lifecycle.startRunnerLockHeartbeat` →
   `RunnerLockCoordinator.startHeartbeat`).

The paused-run resume path has the same gap: `WorkflowInstance.ts:2453`
`ensureRunnerLock`, then `:2459` `prepareExecutionWorktree`, then `:2462`
`startWorkflowExecution`.

`dev/bugs/implemented/managed-worktree-setup-runs-inside-mutation-lock.md`
fixed this same class of problem for the worktree mutation lock, but the runner
lock and the lease were never covered.

## Suggested Fix

Start heartbeating as soon as the runner lock is acquired, not when execution
starts. Make sure the heartbeat also refreshes the execution lease once
`prepareExecutionWorktree` has created it. Starting the interval twice must be
a no-op, and every failure path between acquisition and execution must still
stop the interval and release the lock. Add a regression test that drives a
setup that outlasts `STALE_HEARTBEAT_MS` (injected clock or fake timers) and
asserts that the lock and lease heartbeats were refreshed during it.
