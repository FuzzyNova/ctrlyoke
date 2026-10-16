# "Run Next" on a paused workflow inserts after the next pending step

- **Found:** 2026-10-15 by claude-cli bug-hunt final step (traced; `resolveQueueInsertIndex` arithmetic confirmed)
- **Area:** `src/ui/webview-react/components/editor/PromptEditor.tsx`, `src/core/WorkflowInstance.ts`
- **Severity:** medium

## Symptom

`docs/guide/dashboard.md` ("Adding steps: Queue and Run") says that when the
workflow has pending steps the button reads **Run Next** and "the new step runs
before them". On a **paused** workflow the new step is inserted one position
too late: the next pending step runs first on Resume.

## Steps to Reproduce

1. Workflow with steps `[s0, s1, s2, s3, s4]`; pause after `s1`. The paused
   run's `currentIndex` is 2 (the next pending step).
2. Type a prompt in the editor and click **Run Next**.
3. `resolveQueueInsertIndex(NEXT, 2, 5)` returns 3 → `[s0, s1, s2, NEW, s3, s4]`.
4. On Resume `s2` runs before `NEW`.

The same off-by-one hits IDLE with `currentStep > 0` (a draft whose start
position was set): the start step runs before the new one.

## Root Cause

`PromptEditor.tsx` `resolveFinalAction` (around line 880) returns `RUN_NEXT`
for PAUSED (and for IDLE with `currentStep > 0`). `WorkflowInstance` maps
`RUN_NEXT` to `QUEUE_POSITION.NEXT` = `currentIndex + 1`, which is right only
while a step is in flight. As `core.instructions.md` documents, a pause is
confirmed at a step boundary, so a paused run's `currentIndex` already names
the next PENDING step — `BEFORE_CURRENT` (= `currentIndex`) is the correct
position. STOPPED already maps to `RUN_BEFORE_CURRENT` for this reason; PAUSED
was missed.

## Suggested Fix

In `resolveFinalAction`, return `RUN_BEFORE_CURRENT` whenever no step is in
flight (STOPPED, PAUSED, and IDLE at any start position); keep `RUN_NEXT` only
while a step is executing (RUNNING/PAUSING). Prefer the existing in-flight
predicate (`isExecutionBusy`) over enumerating states. Add a webview test for
the paused case, and check the CLI/MCP `next` position for the same mismatch
while paused.
