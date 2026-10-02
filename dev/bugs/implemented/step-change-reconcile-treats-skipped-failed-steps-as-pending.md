# Step-list changes reopen or strand finished runs that contain skipped or failed steps

- **Found:** 2026-10-02 by bug-hunt final step (source review)
- **Area:** `src/core/WorkflowInstance.ts`, `src/core/PromptQueue.ts`
- **Resolution:** fixed in this commit

## Symptom

A finished run that has any step not in `COMPLETED` status is reconciled
wrongly after a step-list change. That covers a disabled/skipped step, a step
skipped by a failing pre-condition, a cancelled step, and a step that failed
under `errorBehavior: continue`.

- **Undo/redo:** any step-list undo/redo on the completed run moves it from
  `COMPLETED` to `STOPPED` and offers Resume, even though no step is pending.
- **Delete:** if the user appends step C to the completed run (which reopens it
  to `STOPPED`) and then deletes C, the run stays `STOPPED`/resumable with
  `currentIndex === steps.length`. It should return to `COMPLETED`.

## Steps to Reproduce

1. Run a workflow `[A, B (enabled: false)]` to completion: A is `COMPLETED`,
   B is `SKIPPED`, and the run is `COMPLETED`.
2. Append a step C from the dashboard, then delete it.
3. Observe that the run stays `STOPPED` with Resume shown, instead of
   returning to `COMPLETED`.
   (Alternatively, perform any step-list undo/redo on the completed run. It
   flips to `STOPPED`.)

## Root Cause

`WorkflowInstance.reconcileExecutionStateAfterStepChange` compares
`promptQueue.getCompletedCount()` with `steps.length`.
`PromptQueue.getCompletedCount` counts only results whose status is exactly
`STEP_STATUS.COMPLETED`, so terminal SKIPPED/CANCELLED/FAILED steps count as
remaining work. The method's own doc comment describes the reopen branch as
"COMPLETED + **non-terminal** steps present". No test covers the reconcile
method with non-COMPLETED terminal steps.

`WorkflowStartupPipeline.ts` also uses `getCompletedCount()` to decide whether
a run is a continuation (`prevCompletedCount > 0`). Check it for the same
mistake: a finished run whose steps all skipped or failed scores 0.

## Suggested Fix

The two branches need different counts:

- **COMPLETED → reopen branch:** reopen only when some step has **no terminal
  result** (no COMPLETED, SKIPPED, CANCELLED or FAILED result). A run that is
  already COMPLETED has nothing to resume in a skipped or failed step.
- **STOPPED → COMPLETED branch:** be careful. A run stopped mid-step leaves
  that step CANCELLED (or FAILED), and Resume must re-run it, so CANCELLED and
  FAILED must **not** count as done here. Count COMPLETED plus SKIPPED results.
  Before you decide, check how Resume treats each status in `WorkflowExecutor`
  and `PromptQueue`, and match that.

Add a small `PromptQueue` helper for each count instead of inlining filters,
and keep `getCompletedCount` for display uses that really mean completed. Add
WorkflowInstance tests: a skipped step with delete, a skipped step with undo,
and a run stopped with a CANCELLED step whose pending step is deleted, which
must stay STOPPED.

## Resolution Details

Reconciliation now distinguishes any terminal result from results that Resume
will not re-run. A completed run reopens only when at least one step has no
terminal result; a stopped run completes only when every remaining step is
COMPLETED or SKIPPED. CANCELLED and FAILED do not satisfy the stopped-run
count.

WorkflowStartupPipeline.classifyContinuation also used getCompletedCount() to
decide whether an appended pending step continues an existing completed run. A
completed run containing only skipped steps therefore looked like a fresh run
and was restarted. It now uses the completed-or-skipped count for that
decision, restores the prior completed/skipped statuses, and uses currentIndex
as the settled-prefix boundary. getCompletedCount() remains unchanged for
display uses.
