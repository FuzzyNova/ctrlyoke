# Completion notifications are deduped per run forever; dismiss cleanup never matches the dedupe keys

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/ui/NotificationManager.ts`
- **Severity:** low

## Symptom

The VS Code "Workflow Complete" / "Workflow Failed" toast, and the per-step completion toasts, appear only the first time for a given run. If the same run is continued after appending steps, or re-run after a rewind, and completes again, no notification appears. Dismissing the workflow does not reset this, and `notifiedKeys` keeps growing for the life of the extension host.

## Steps to Reproduce

1. Enable `notifications.vscode.enabled` (and set `onlyWhenWindowUnfocused` to false, or keep the window unfocused).
2. Run a workflow to completion. The "Workflow Complete" toast appears (id `<workflowKey>:<runRef>:workflow:completed`).
3. Append steps to the completed run (`RunContinuationService` APPEND) and continue it in the same `runRef`.
4. When it completes again, `isWorkflowCompletionTransition` fires, but `showNotification` returns early because the id is already in `notifiedKeys`. No toast appears.
5. Alternatively, rewind to step `i` and re-run it. The `prompt:<i>:completed` toast is suppressed too.
6. Dismiss the workflow and repeat. Notifications are still suppressed, because `notifyWorkflowDismissed` only deletes keys starting with `<instanceId>:`.

## Root Cause

- `src/ui/notifications/CompletionNotificationFactory.ts:93-97` (`notificationIdentity`) returns `${workflowKey}:${runRef}` whenever both are set, which is always true for a real run. Event ids are built from it at line 163 (`…:workflow:${state}`) and line 215 (`…:prompt:${stepIndex}:${stepStatus.state}`).
- `src/ui/NotificationManager.ts:135-138` dedupes on `event.id` permanently. Ids are never removed when a run leaves a terminal state.
- `src/ui/NotificationManager.ts:42-46` (`notifyWorkflowDismissed`) prunes only keys prefixed with the instance id `${workflowId}:`. That format stopped matching once ids moved to the durable `workflowKey:runRef` identity (commit ea655e384), so the pruning never removes anything.

As a result, a dedupe key never resets when the same run completes again, or when the workflow is dismissed.

## Suggested Fix

Dedupe on transitions instead of keeping ids forever:

- Clear a summary's keys when it leaves a terminal state: in `notifyWorkflowSummaryUpdated` when `executionState` moves back to running, and in `updateStepStatus` when a step re-enters running. Remove keys by the prefix `notificationIdentity(summary) + ":"`, exported as a helper from `CompletionNotificationFactory.ts` so the format stays single-sourced.
- Make `notifyWorkflowDismissed` compute that same prefix from the cached summary before deleting it from `workflowSummaries`.
- Alternative: add a per-attempt or per-pass discriminator to the event id, such as the completion timestamp or the step attempt number.

Add a unit test for complete → append → complete again that expects two toasts, and one for dismiss clearing the keys.
