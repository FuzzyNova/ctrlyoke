# Deleting the displayed lineage locks it as 'deleted' with no rollback when the delete is refused or undone

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/ui/webview-react/components/workflow/WorkflowStatus.tsx`
- **Resolution:** fixed in this commit

## Symptom

After the user deletes the lineage currently on screen, the header shows the `"<name>" has been deleted` banner, and queue, duplicate, step and properties editing are disabled. The lockdown stays in place even when nothing was deleted (the backend refused a live lineage) and after the user restores the lineage with the toast's Undo. It clears only when the user navigates to a different workflow.

## Steps to Reproduce

Case A (refused delete):

1. Open lineage X in the dashboard while `ctrlyoke run` executes X from the CLI (or while another VS Code window holds its runner lock), so this panel does not show X as executing.
2. Open the workflow dropdown and click the trash button on X's recent row, or use Delete Workflow in the header context menu. Confirm if prompted.
3. The backend throws `LiveLineageDeleteError`, shows a "could not delete workflow history" failure and resends the recent list, so X reappears in the list.
4. The header still shows `"X" has been deleted` and editing stays disabled, although X was never deleted.

Case B (undo):

1. With X idle and displayed, delete X. The success toast appears with an Undo action.
2. Click Undo. X is restored from Recently deleted and reappears in the recent list.
3. The displayed view of X stays locked under the "has been deleted" banner until you navigate to another workflow and back.

## Root Cause

`markIfViewingDeletedLineage` (`src/ui/webview-react/components/workflow/WorkflowStatus.tsx:1118-1124`) sets `uiStore.viewingDeletedWorkflow` optimistically. It runs right after `REMOVE_WORKFLOW_HISTORY` is posted (lines 1135 and 1171). The comment at lines 1113-1117 is stale: it says the backend hard-deletes immediately and sends no reply.

The real path is `WorkflowSerializer.handleRemoveWorkflowHistory` (`src/ui/WorkflowSerializer.ts:1548-1579`), which calls `HistoryTrashRepository.trashLineage` (`src/core/orchestration/HistoryTrashRepository.ts:430-449`). That moves the lineage to Recently deleted, and it can refuse with `LiveLineageDeleteError` (line 436; the liveness check is `isLineageLive` at lines 409-427). On refusal the serializer only sends an action failure and a fresh recent list (`WorkflowSerializer.ts:1570-1576`). On success, the `HISTORY_TRASHED` handler (`src/ui/webview-react/hooks/useMessageHandler.ts:768`) offers Undo via `HISTORY_TRASH_RESTORE`.

No handler clears `viewingDeletedWorkflow`: not the failure, the recent-list resend, `HISTORY_TRASH_RESULT` (`useMessageHandler.ts:806`) or the restore. The flag's only other writers are `ClearHistoryModal.tsx:61` and the store reset at `uiStore.ts:2558`. So `useIsViewingDeletedWorkflow` keeps returning true for the workflowKey still on screen.

## Suggested Fix

- Stop setting the flag optimistically. Set `viewingDeletedWorkflow` only after the backend confirms the move, in the `HISTORY_TRASHED` handler, when the trashed entry covers the displayed workflowKey. Either the message carries the workflowKey(s), or the client keeps a pending key from the request.
- Clear the flag when that lineage is restored: for example, when `HISTORY_TRASH_RESULT` reports a successful restore of an entry containing the displayed workflowKey, or when a recent-workflows list that includes the key arrives.
- If the optimistic set stays, then at minimum clear `viewingDeletedWorkflow` in the delete-failure path (where the serializer resends recent workflows) and on a successful restore.
- Update the stale "hard-deletes immediately" comment.
- Add Vitest coverage in `WorkflowStatus.test.tsx` and the `useMessageHandler` tests for both the refused-delete case and the undo case.
