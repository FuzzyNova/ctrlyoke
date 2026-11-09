# Error icon lands on the wrong row after a parallel-group failure

- **Found:** 2026-11-09 by bug-hunt final step (claude-cli)
- **Area:** `src/ui/webview-react/hooks/usePromptStatus.ts`
- **Resolution:** fixed in this commit

## Symptom

After a parallel group fails and stops the run, the dashboard paints a
`failed` status on a step that never ran or on a member that succeeded.

## Steps to Reproduce

Case A (before any edit):

1. Parallel group `{ startIndex: 0, endIndex: 1, failFast: false }`, then a pending step 2.
2. Member 0 fails, member 1 completes. `executionState: ERROR`, `currentStep: 2`.
3. Step 3 (never executed) is labelled `failed`; the panel shows two failed rows instead of one.

Case B (after an edit rewinds the group):

1. Same group; member 0 completed (`terminalStatus: completed`), member 1 has
   `_runtime.rewoundFailure: true`.
2. `executionState: ERROR`, `currentStep: 0` (the live queue's state right after
   `updatePrompt(1, …)` rewinds the group).
3. The completed member 0 is labelled `failed`.

## Root Cause

`usePromptStatus.ts:85-97` returns FAILED for `index === currentStep` in an ERROR
run unless `steps[currentStep - 1].status === FAILED`, and it does so before
reading the step's own recorded status. That guard assumes the failure is always
the step just before the head, which stopped being true once a28342809/3d06f3557
made a failed group stop with the head past the group, and made an edit rewind
the head to the group's start.

## Suggested Fix

Only fall back to the eager FAILED override when nothing in the run carries a
terminal failure. Concretely, skip it when
`getProtectedTerminalFailure({ executionState, currentIndex: currentStep, steps, parallelGroups }).indices`
(from `src/utils/StepStatusDerivation.ts`) is non-empty, and prefer the step's
own terminal `_runtime`/`status` over the override. Add vitest cases for both
shapes.
