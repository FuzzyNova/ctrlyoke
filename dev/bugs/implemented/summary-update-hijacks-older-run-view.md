# Viewing an older run while the latest run executes pulls the live run into the older run's view

- **Found:** 2026-09-28 by lots-of-bug-fixes final step (Claude)
- **Area:** `src/ui/webview-react/hooks/useMessageHandler.ts`, `src/ui/webview-react/store/uiStore.ts`
- **Resolution:** fixed in this commit

## Symptom

While run R2 of a lineage is executing, open an older run R1 of the same lineage in the dashboard
(webview or hosted browser). On the next state change of the executing instance (step advance,
pause/resume), R1's view flips to "running" with R2's step counter. R1's run-list row is marked
running, and from then on R2's step status and output messages are applied to R1's view.

## Steps to Reproduce

Verified with a throwaway vitest probe against the real stores and handlers:

1. The ui store shows `displayedViewAddress = { kind: run, runRef: R1 }` (R1 completed) and
   `executionRunRef = R2`, with `activeWorkflowId` pointing at the instance that owns R2. Viewing an
   older run adopts the instance that owns the executing run (`WorkflowOrchestrator.ts`, around
   line 2916), so `activeWorkflowId` matches.
2. Dispatch `WORKFLOW_SUMMARY_UPDATED` with
   `summary: { id: activeWorkflowId, executionState: running, currentStep: 0, totalSteps: 5 }`.
   The backend sends this on every state change (`WorkflowInstanceRegistry.ts` around line 640,
   and `CtrlYokeHostedServer.ts` around line 332 for the hosted browser).
3. R1's view now shows running, step 0 of 5. `executionRunRef` has become R1 and R1's run summary
   is `running`.
4. Dispatch a `STEP_STATUS_CHANGED` for R2: R1's step 0 changes from `completed` to `running`.

## Root Cause

- The summary payload has no top-level `workflowId`, so the run-view guard in the message
  listener (`useMessageHandler.ts`, around lines 3210-3217) never drops it. That guard drops
  instance-tagged messages when `executionRunRef !== displayedViewAddress.runRef`.
- The `WORKFLOW_SUMMARY_UPDATED` handler (around lines 2989-2994) only checks
  `summary.id === activeWorkflowId`. It then writes `currentStep`, `totalSteps` and the execution
  state into `workflowStore`, and calls `applyExecutionState`.
- `applyExecutionState(RUNNING)` (around line 510) calls `uiStore.markExecutionRunStarted()`
  (`uiStore.ts`, around lines 2062-2078). That sets `executionRunRef` to the displayed run whatever
  it was before. After that the run-view guard sees `executionRunRef === displayedViewAddress.runRef`
  and stops filtering every later message.

## Suggested Fix

- Factor the run-view guard's predicate ("displayed view is a run other than the executing run")
  into one helper.
- Use that helper in the listener and in the `WORKFLOW_SUMMARY_UPDATED` handler. The handler
  should still update the recent-workflows row, but skip the `workflowStore` and
  `applyExecutionState` sync when an older run is displayed.
- `markExecutionRunStarted` must not overwrite a non-null `executionRunRef` that names a
  different run. Its continuation use case is `executionRunRef` null or stale for the displayed
  run, which is exactly the run being continued. Check how `executionRunRef` is set on
  continuation before changing this.

Regression tests (vitest):

- The scenario above leaves R1's view, `executionRunRef` and R1's run summary unchanged, and a
  later R2 `STEP_STATUS_CHANGED` is dropped.
- The continuation case (displayed run == run being continued) still marks that run running.
