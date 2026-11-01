# `append_step` with a numeric position inside a running parallel group is rejected, though `next` at the same index is relocated

- **Found:** 2026-11-01 by bug-hunt final step (claude-cli)
- **Area:** `src/core/orchestration/RunContinuationService.ts`, `src/core/PromptQueue.ts`
- **Resolution:** fixed in this commit

## Symptom

While a parallel group is running and all its members have started, an
`append_step` call with a numeric `position` that falls inside the group fails
with:

    Cannot insert the currently executing step: the step has already started

`position: "next"` resolves to the same requested index, but that call
succeeds: the insert is relocated past the group, and the response includes
`placement.relocation: { kind: "afterParallelGroup" }`. So whether a numeric
insert is relocated or refused depends only on whether the member at that
index has started yet. In practice every member starts at once. The error
message is also misleading, because the caller is not inserting "the currently
executing step".

The common trigger is a group member queueing work "right after me"
(`position: myIndex + 1`).

## Steps to Reproduce

1. Run state: `RUNNING`, `currentIndex: 1`, and
   `parallelGroups: [{ id: "g", startIndex: 1, endIndex: 2 }]`, with
   `_runtime.startedAt` set on both steps 1 and 2.
2. Call `append_step { "steps": [{ "prompt": "x" }], "position": 2 }`.
3. The call is refused with the error above. With `"position": "next"`, the
   same step is inserted at index 3.

## Root Cause

In `RunContinuationService.appendStepsToRun`
(`src/core/orchestration/RunContinuationService.ts:483-495`),
`assertEditableDuringExecution(source, steps, requestedIndex, "insert")` runs
against the raw requested index. The parallel-group relocation
(`resolveParallelGroupInsertIndex(..., AFTER)`) is only computed afterwards.
The existing tests (`RunContinuationService.test.ts` around `:1746`,
`McpServer.test.ts` around `:3896`) only cover a member that has not started.
`PromptQueue.insertAfter` (`src/core/PromptQueue.ts:2339`) has the same order
for dashboard inserts.

## Suggested Fix

Compute `placement` first. Then run the during-execution check against
`placement.insertedIndex`, or rely on
`assertStartedStepPositionsPreserved(sourceTopology.steps, nextTopology.steps, "insert")`,
which guarantees no started step moves. Make the same change in
`PromptQueue.insertAfter` if that path can reach the same state. Add tests
where the member at the requested index has started.
