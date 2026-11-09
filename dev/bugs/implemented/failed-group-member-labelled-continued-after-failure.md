# Failed parallel-group member is labelled "Workflow continued after failure"

- **Found:** 2026-11-09 by bug-hunt final step (claude-cli)
- **Area:** `src/ui/webview-react/components/prompts/WorkflowStepRow.tsx`
- **Resolution:** fixed in this commit

## Symptom

A run stopped by a failed parallel group shows the failed member's message as
"Workflow continued after failure: …", even though the workflow did not
continue and the member's failure is what stopped the run.

## Steps to Reproduce

1. Workflow with a parallel group `{ startIndex: 0, endIndex: 1, failFast: false }`
   followed by a pending step 2.
2. Member 0 fails (`failureMessage: "member failed"`), member 1 completes.
3. Run state: `executionState: ERROR`, `currentStep: 2`.
4. Render `WorkflowStepsPanel`: member 0's row reads
   "Workflow continued after failure: member failed".

## Root Cause

`WorkflowStepRow.tsx:135-138` computes `workflowContinuedAfterFailure` as
`status === FAILED && index < currentStep && (executionState !== ERROR || index < currentStep - 1)`.
In an ERROR run it treats only `currentStep - 1` as the step that stopped the
run. After a group join the head sits at `endIndex + 1`, so any failed member
other than the group's last one falls into the "continued" branch. Commits
a28342809 and 3d06f3557 introduced a shared derivation for exactly this
(`getProtectedTerminalFailure` / `getTerminalFailureRetry` in
`src/utils/StepStatusDerivation.ts`), but this row did not adopt it.

## Suggested Fix

A FAILED step is "continued after" only when it is not part of the run's
terminal failure: use `getProtectedTerminalFailure(...)` (with
`parallelGroups`) or the step's `_runtime.terminalFailure === false` instead of
the `currentStep - 1` heuristic. Add a `WorkflowStepsPanel`/`WorkflowStepRow`
vitest case for the failed-group shape.
