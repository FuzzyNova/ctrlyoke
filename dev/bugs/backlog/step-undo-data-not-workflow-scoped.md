# `STEP_UNDO_DATA_UPDATED` carries no workflow id, so one workflow's undo snapshot lands on another's step

- **Found:** 2026-09-28 by lots-of-bug-fixes final step (Claude)
- **Area:** `src/core/WorkflowTaggedSink.ts`, `src/ui/PostMessageDashboardSink.ts`, `src/types/WebviewMessageTypes.ts`, `src/ui/webview-react/hooks/useMessageHandler.ts`
- **Severity:** medium

## Symptom

When a step finishes in workflow A while the dashboard shows workflow B, A's workspace snapshot
is written into B's `workspaceSnapshots` for the same target (for example, queue step 0). A's
changed files then appear as undo candidates on B's step 0, and B's own snapshot for that step is
lost.

## Steps to Reproduce

1. Run workflow A in the background while workflow B is displayed.
2. When A's step 0 completes, the dashboard receives `STEP_UNDO_DATA_UPDATED` with no workflow id.
3. B's step 0 now offers undo for A's file changes.

## Root Cause

- `WorkflowTaggedSink.sendStepUndoDataUpdated` (around line 427) forwards the call without
  `this.workflowId`, unlike every other tagged-sink method.
- `IDashboardSink.sendStepUndoDataUpdated`, `PostMessageDashboardSink` (around line 499) and
  `StepUndoDataUpdatedMessage` have no workflow field.
- The handler (`useMessageHandler.ts`, around line 3158) applies the message unconditionally.

## Suggested Fix

Thread `workflowId` through `IDashboardSink.sendStepUndoDataUpdated`, every sink implementation,
and the message type. Tag it in `WorkflowTaggedSink`, and guard in the handler using the same
active-workflow check as the other handlers. Add a test for the tagged sink and one for the
handler.
