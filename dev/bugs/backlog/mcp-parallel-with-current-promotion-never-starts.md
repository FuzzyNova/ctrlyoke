# `append_step` `parallelWithCurrent` on a lone running step queues instead of running alongside

- **Found:** 2026-11-01 by Claude Code (bug-hunt final step, exercising the MCP server)
- **Area:** `src/core/orchestration/RunContinuationService.ts`, `src/core/WorkflowExecutor.ts`
- **Severity:** high

## Symptom

An agent running in a plain sequential step (not already part of a parallel group) calls the
MCP `append_step` tool with `position: "parallelWithCurrent"`. The response reports success:
`"destination": "activeParallelGroup"` and `joinedParallelGroup.promoted: true`. But the new
step does not start until the calling step has **finished**, so it runs in series. An agent
that waits on its "parallel" helper deadlocks until the step's own timeout. The dashboard's
in-process "Run in Parallel" action works, because it goes through a different path.

## Steps to Reproduce

1. In a scratch workspace, create a workflow whose step 0 is a script step
   `node -e "setTimeout(()=>{},45000)"`, followed by an `echo` step, and run it with
   `ctrlyoke run j.ctrlyoke.yaml --json`.
2. About 6 seconds in, call
   `node out/mcp-server.js --tool append_step --args '{"steps":[{"prompt":"placeholder"}],"position":"parallelWithCurrent"}'`
   with the working file set to that run. To keep it free, turn the new step into a script with
   `ctrlyoke step edit`.
3. The response says `promoted: true`, and the session log shows
   `mergeStepsFromDisk: Found 1 new steps…`. But the joined step's `_runtime.startedAt` lands
   about 40 seconds later, within 0.5 seconds of the long step's `completedAt`.

## Root Cause

- `RunContinuationService` promotes the running step into an ad-hoc parallel group and
  writes it to disk (#selection:src/core/orchestration/RunContinuationService.ts:707-729).
- The running executor merges those steps from disk, but its `onDidMergeDiskSteps` handler
  returns immediately when `activeParallelGroupRun` is unset
  (#selection:src/core/WorkflowExecutor.ts:559-563). After a promotion it is always unset,
  because the anchor is still running on the sequential path.
- The only code that starts a promoted group beside its in-flight anchor is
  `admitParallelGroupMember` → `startPromotedParallelGroupRun`
  (#selection:src/core/WorkflowExecutor.ts:1524-1585), reached only through
  `joinRunningParallelGroup`. That has one caller, the dashboard's in-process path at
  `WorkflowInstance.ts:3527`.

`RunContinuationService.test.ts` only checks the returned `promoted` flag, so no test covers
the executor actually starting the member.

## Suggested Fix

When steps merged from disk land in the promoted group whose `startIndex` is `currentIndex`
(the active parallel-group runtime names it and it is `ACCEPTING`), call
`joinRunningParallelGroup(index)` for each newly merged member, in order. Do this in
`onDidMergeDiskSteps` when there is no `activeParallelGroupRun`, or right after the disk
merge. `admitParallelGroupMember` currently insists on `stepIndex === candidate.endIndex`.
Check that a multi-step `parallelWithCurrent` append (promotion plus extra members) admits
every member, not just the last one. Add an executor-level regression test that drives the
disk-merge path, not the in-process join.
