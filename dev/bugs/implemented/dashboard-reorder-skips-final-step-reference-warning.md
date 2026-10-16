# Dashboard drag-reorder doesn't warn when the final step's `$step:N` now points elsewhere

- **Found:** 2026-10-15 by claude-cli bug-hunt final step (confirmed by calling `findShiftedStepReferences` with each call site's options)
- **Area:** `src/core/PromptQueue.ts`
- **Resolution:** fixed in this commit

## Symptom

Steps `[A, B, C]` with final step `Summarize $step:2`. Drag-reorder to
`[A, C, B]` in the live dashboard: no shifted-reference warning appears,
although the final step now reads C's output instead of B's. The same reorder
through the CLI or MCP (`reorder_steps`) does warn about "Final step".

## Steps to Reproduce

1. Create the workflow above and open it in the dashboard.
2. Drag C above B.
3. No toast. Through `WorkingFileManager.reorderStepsAtRun` the same change
   reports `['Final step']`.

## Root Cause

`PromptQueue.reorderPendingPrompts` (around line 3082) calls
`findShiftedStepReferences(previousSteps, nextTopology.steps, { workflowDefaults: this.workflowFile })`
without `finalStep`. Every other topology path passes
`finalStep: this.workflowFile?.finalStep` (insert/append/delete in
`PromptQueue` around lines 2028, 2173, 2312, 2949, plus
`WorkingFileManager.reorderStepsAtRun` and
`RunContinuationService.reorderStepsAtRun`). Introduced in `67ea3dfc6`.

## Suggested Fix

Pass `finalStep: this.workflowFile?.finalStep` at that call site, and add a
unit test for a resident-queue reorder that shifts a final-step reference.
