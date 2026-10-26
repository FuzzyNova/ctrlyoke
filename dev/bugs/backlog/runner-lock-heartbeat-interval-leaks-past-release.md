# Runner-lock heartbeat intervals keep running for hours after the lock is released

- **Found:** 2026-10-25 by Claude (session log review)
- **Area:** `src/core/orchestration/RunnerLockCoordinator.ts`, `src/core/WorkflowInstance.ts`
- **Severity:** medium

## Symptom

`ctrlyoke-1792861731571.log` logs `updateHeartbeat: failed` 53 times for lineages that
had finished hours earlier. `workflow-export-plans-2026-10-24T21-02-49-930` released its
runner lock at 23:54:24 and completed, yet 40 heartbeat failures for it were logged
between 00:03 and 04:52. Up to 7 of them fall within the same second, which means
several intervals for that one lineage are still running:

```
23:54:24.608  [WorkflowLockManager] releaseLock: workflow-export-plans-2026-10-24T21-02-49-930
...
04:52:22.894  updateHeartbeat: failed for workflow-export-plans-…: Timed out waiting for lock: …\runner.json.lock
04:52:22.895  updateHeartbeat: failed for workflow-export-plans-…  (×6 more within 4 ms)
04:52:22.896  updateHeartbeat: failed for bouncing-output-animation-…
04:52:22.896  updateHeartbeat: failed for propogate-git-button-errors-…
04:52:22.897  updateHeartbeat: failed for workflow-claude-follow-up-…
```

When the file system is fast, these leaked heartbeats are silent: `updateHeartbeat` takes
the file lock, finds no `runner.json`, and returns. They show up only when lock
acquisition times out, as it did at 04:52 while a 16 s run-view load was reading history.
Each one still costs a lock-file create/delete cycle every 5 s under `~/.ctrlyoke`. That
adds file-system contention exactly when it is already high, and it makes the warnings
point at workflows that are not running.

## Steps to Reproduce

1. Run a workflow, especially in a named worktree with a reusable terminal, or pause and
   resume it a few times.
2. Let it complete.
3. With verbose logging on, slow the file system down (for example, open a large history
   run while Defender scans `~/.ctrlyoke`). `updateHeartbeat: failed` warnings appear for
   the completed lineage.

## Root Cause

`RunnerLockCoordinator.startHeartbeat`
(#sym:src/core/orchestration/RunnerLockCoordinator.ts:startHeartbeat:172-198) assigns
`this.heartbeatInterval = setInterval(...)` without clearing an interval that is already
running. Only the latest timer can then be stopped by `stopHeartbeat`. Every earlier
timer keeps running for the life of the instance and heartbeats the `ownerToken` it
captured.

A second start without a stop is reachable: `releaseExecutionReservations`
(#selection:src/core/WorkflowInstance.ts:5001-5004) skips `stopRunnerLockHeartbeat()`
when `preserveWorktreeReservation` is true. The next `startWorkflowExecution` on that
instance (a resume or follow-up run) then calls `startRunnerLockHeartbeat` again through
`WorkflowStartupPipeline` (#selection:src/core/orchestration/WorkflowStartupPipeline.ts:393-399).
`releaseRunnerLock` also clears the owner token without stopping the interval, so a
heartbeat can outlive its lock on that path too.

## Suggested Fix

- Have `startHeartbeat` call `stopHeartbeat()` first, so one coordinator never owns more
  than one interval.
- Have `releaseRunnerLock` stop the heartbeat as well, so no path can release the lock
  and leave its heartbeat running.
- Add a coordinator unit test: start twice and stop once, then confirm no
  `updateHeartbeat` calls follow (fake timers).
