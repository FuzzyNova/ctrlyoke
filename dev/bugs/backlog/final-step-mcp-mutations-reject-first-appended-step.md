# A running final step can't edit, remove or reorder the first step it appended, or insert at its position, via MCP/CLI

- **Found:** 2026-10-02 by bug-hunt final step (claude-cli), reproduced with `npx tsx` against `RunContinuationService`
- **Area:** `src/core/orchestration/RunContinuationService.ts` (`assertEditableDuringExecution` ~1151-1163, `reorderStepsAtRun` `isRunningHead` ~912, `assertPendingReorderIsSafe` ~1230-1237)
- **Severity:** medium

## Symptom

While the final step runs, `_runtime.currentIndex === steps.length`. The first step the
final step appends with `append_step` lands at `currentIndex` without having started.
Through the MCP/CLI path:

- `edit_step` on it fails with "Cannot edit the currently executing step".
- `remove_step` fails with "Cannot remove the currently executing step".
- `reorder_steps` fails with "Reorder indices must contain exactly N not-yet-started step indices".
- `append_step` with a numeric position equal to `steps.length` fails with "Cannot insert the currently executing step".

Steps appended after the first are fine. The dashboard/`PromptQueue` path allows all of
these (fixed in 166a9047b, test "steps appended by a running final step are all
editable"), so the two paths disagree.

## Root Cause

`RunContinuationService` treats `index === currentIndex` plus an in-flight execution
state as "currently executing" without checking
`_runtime.finalStep.phase === FINAL_STEP_PHASES.FINAL_STEP`, unlike
`PromptQueue.hasInFlightStep`.

## Suggested Fix

Add one phase-aware helper (in-flight state AND not in the final-step phase), mirroring
`PromptQueue.hasInFlightStep`. Use it in all three places, ideally sharing the
predicate with `PromptQueue`. Add `RunContinuationService` tests mirroring the
`PromptQueue` one.
