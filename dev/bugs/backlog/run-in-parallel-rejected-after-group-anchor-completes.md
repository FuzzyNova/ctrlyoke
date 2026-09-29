# Run in Parallel is rejected once the running group's first member has finished

- **Found:** 2026-09-29 by bug-hunt final step (claude-cli)
- **Area:** `src/core/WorkflowInstance.ts` (`executeEphemeralParallelPrompt`)
- **Severity:** medium

## Symptom

A group is still running and accepting members. Its first member (the anchor)
has completed while another member is still running. The dashboard's
**Run in Parallel** action (`ACTION_TYPES.RUN_PARALLEL`) then fails with
`No step is running. Run in Parallel was rejected.` The MCP path
(`append_step` with `position: "parallelWithCurrent"`,
`RunContinuationService.appendStepsToActiveParallelGroup`) accepts the same
request in the same state.

## Steps to Reproduce

Reproduced with a temporary unit test in `WorkflowInstance.test.ts`:

1. Load steps `[anchor, member]` with group `{ id: "group-1", startIndex: 0, endIndex: 1, failFast: false }`
   and start queue execution.
2. `setActiveParallelGroupAdmission("group-1", ACCEPTING)`. Set step 0
   `_runtime = { startedAt, completedAt }` and step 1 `_runtime = { startedAt }`.
3. `executeEphemeralPrompt("parallel member", {}, ACTION_TYPES.RUN_PARALLEL)`.
4. It throws `No step is running…`. Expected: the step is appended as index 2
   and `joinRunningParallelGroup(2)` is called.

## Root Cause

`executeEphemeralParallelPrompt` (WorkflowInstance.ts ~3264) validates
`state.steps[state.currentIndex]`: it must have started and not completed. While
a group runs, `currentIndex` stays on the group's `startIndex` until the join
(by design), so once the anchor settles the check fails, even though
`getCurrentParallelGroup()` is active and `ACCEPTING`.

## Suggested Fix

When `getCurrentParallelGroup()` returns a group, require that _any_ member has
started and not completed, as `appendStepsToActiveParallelGroup` does. Share
one helper between the two paths rather than duplicating the check. Keep the
single-step check only for promoting an ungrouped running step. Add a unit test
for the scenario above.
