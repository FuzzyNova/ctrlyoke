# A step claim adopts new disk steps without notifying the executor, so a second `parallelWithCurrent` join waits for the anchor

- **Found:** 2026-11-01 by bug-hunt final step (claude-cli)
- **Area:** `src/core/PromptQueue.ts` (`claimStepById`)
- **Severity:** medium

## Symptom

A running agent (the anchor) calls `append_step` with `parallelWithCurrent`
twice: helper1, then helper2. helper1 is admitted beside the anchor, as
~7a9ee0bff intended. If helper2's append reaches the working file between
the watcher's merge and helper1's step claim, helper2 is never admitted while
the anchor runs. It only starts when the group closes
(`reconcileAndCloseParallelGroup` admits leftover members), after the anchor
settles. An anchor that waits on helper2 then stalls until it gives up. That
is the "agent waits on its parallel helper" failure ~7a9ee0bff fixed for the
first member. Groups started by the queue loop are affected the same way:
an MCP-joined member waits for the group to close instead of taking the next
free slot.

## Steps to Reproduce

Reproduced with a temporary integration test modelled on "starts every
member of an out-of-process parallelWithCurrent promotion…" in
`src/test/integration/parallelMutation.integration.test.ts`:

1. Call `appendStepsToActiveParallelGroup` for helper1, then run the watcher
   merge.
2. Hold helper1's claim until a second `appendStepsToActiveParallelGroup`
   (helper2) has been written, then release it. Run the watcher merge again
   300 ms later.
3. Observed: helper2 never started during the anchor. Event order:
   `claim-done:0, claim-start, append2-written, claim-done:1, …, claim-done:2`.

Without the forced ordering, helper1's claim reads the file first and the
existing test passes, so whether it works depends on timing.

## Root Cause

`claimStepById` (`PromptQueue.ts` around line 1692) adopts the definition
the claim transaction read with
`this.mergeDiskSteps(workingFile.steps ?? [], workingFile.parallelGroups)`.
Every other in-process merge, `mergeDiskDefinition` (around line 2738), its
callers at lines 1075 and 1991, and the `WorkingFileManager` path at line
193, both passes `diskActiveParallelGroup` and fires
`onDiskStepsMergedEmitter` for new steps. `core.instructions.md` requires
every `mergeDiskSteps` caller to pass `diskActiveParallelGroup`. Because the
claim takes helper2 into memory silently, the watcher's next poll finds no
new steps, `onDidMergeDiskSteps` never fires, and
`admitMergedPromotionMembers` never sees helper2.

## Suggested Fix

In `claimStepById`, merge through `this.mergeDiskDefinition(workingFile)`.
After applying the claimed step, fire `onDiskStepsMergedEmitter` with any
newly merged steps, the way the paths at lines 1075 and 1991 do. Add the
scenario above as a regression test in `parallelMutation.integration.test.ts`,
asserting that helper2 starts while the anchor is still in flight.
