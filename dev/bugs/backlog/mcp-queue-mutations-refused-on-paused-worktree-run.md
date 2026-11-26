# MCP queue changes are refused on a paused run that keeps its runner lock (worktree runs)

- **Found:** 2026-11-25 by bug-hunt final step (claude-cli subagent)
- **Area:** `src/core/orchestration/RunContinuationService.ts`, `src/core/WorkflowInstance.ts`
- **Severity:** low (low confidence on real-world reach; the code path is certain)

## Symptom

`docs/reference/mcp-tools.md:10` says `append_step`, `edit_step`,
`remove_step` and `reorder_steps` are accepted while the run is "running,
pausing, paused, or cancelling". For a paused run whose runner lock is still
live (a worktree run keeps its reservation while paused), they fail with
`Cannot append while this run is executing (state paused)`. The same call on a
paused run without a worktree succeeds. The error message also wrongly calls
a paused run "executing".

The docs' `cancelling` claim is also inaccurate: cancelling is always refused,
on purpose (`RunContinuationService.ts:258-260`: "Stop discards the step's
outcome").

## Steps to Reproduce

Against the compiled `out/mcp-server.js`, on one paused run:

1. With no `runner.json`, `append_step({ position: "end", steps: [{ prompt: "x" }] })`
   succeeds.
2. Acquire a live runner lock naming that run, which mirrors the
   worktree-pause state, and repeat the call. It fails with
   `Cannot append while this run is executing (state paused)`.

Not yet reproduced through a real paused worktree run in VS Code. The
dashboard host may route same-process edits in place before this validator,
which is why confidence is low.

## Root Cause

- `WorkflowInstance.settleWorkflowExecution` (~lines 5184-5226): with a
  worktree, `pausedWorktreeReservation` sets `preserveWorktreeReservation`, so
  `releaseExecutionReservations` keeps the runner lock and heartbeat while
  paused.
- `RunContinuationService.validateContinuationTarget` (~lines 261-268):
  `activeTargetOperation` is true only for `RUNNING`/`PAUSING`. An active lock
  naming a `PAUSED` target therefore throws at ~line 311, and
  `allowInterruptedRun` (~line 358) only applies without an active lock.

## Suggested Fix

Decide which behavior is intended. Either let `PAUSED` with an active lock
naming the target count as `activeTargetOperation` for APPEND and EDIT (no step
is in flight, and appended steps run on Resume), or keep the refusal and fix
`docs/reference/mcp-tools.md` and the error message to say "paused". In
either case, drop `cancelling` from the docs' accepted list. Add a
`McpServer.test.ts` case: a paused run plus a live lock naming it.
