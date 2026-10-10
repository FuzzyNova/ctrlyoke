# Dragging a step into a parallel group skips the sibling-reference check

- **Found:** 2026-10-10 by claude-cli bug-hunt final step (review of ~6e1cd5461)
- **Area:** `src/core/PromptQueue.ts` (`reorderPendingPrompts`), `src/core/orchestration/RunContinuationService.ts` (`reorderStepsWithOrder`), `src/core/WorkingFileManager.ts` (reorder with `pendingGroups`)
- **Resolution:** fixed in this commit

## Symptom

~6e1cd5461 (fix for
`dev/bugs/implemented/append-step-accepts-parallel-sibling-session-reference.md`)
extracted `assertNoParallelSiblingReferences` into
`src/core/ParallelGroupTopology.ts` and runs it on append, join, edit,
replace and update. Reorders that change group membership are not covered.
Pending step 3 with `resumeSession: true, sessionId: 2`, dragged on the
dashboard into a new or existing group with step 2, produces group `[2, 3]`
in which step 3 resumes its own sibling — the shape the file parser rejects.
The same applies to numeric `priorContext` references.

## Steps to Reproduce

1. Pending steps 2 and 3, step 3 has `resumeSession: true, sessionId: 2`.
2. Drag step 3 into a parallel group with step 2 (a reorder with
   `pendingGroups`).
3. The reorder succeeds; loading the saved definition from a file would fail.

## Root Cause

`PromptQueue.reorderPendingPrompts` (~3116),
`RunContinuationService.reorderStepsWithOrder` (~1055) and the
`WorkingFileManager` reorder path (~1753) renumber steps and write the new
topology without calling `assertNoParallelSiblingReferences`.

## Suggested Fix

Call `assertNoParallelSiblingReferences({ steps: renumbered.steps, parallelGroups: nextTopology.parallelGroups }, …)`
in all three reorder paths, reusing the message the other mutations use. Tests:
a drag-into-group case for `PromptQueue` (dashboard) and
`RunContinuationService` (MCP `reorder_steps`).
