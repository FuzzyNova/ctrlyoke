# `UNDO_RECORD_UPDATED` is not scoped to a workflow/run, so a late update can mark the wrong step undone

- **Found:** 2026-09-30 by the bug-backlog workflow final step (claude-cli); traced in code, not reproduced
- **Area:** `src/ui/UndoRedoCoordinator.ts` (~471-481), `src/ui/webview-react/hooks/useMessageHandler.ts` (~3163)
- **Severity:** low (confidence: medium; only happens if the user navigates during the async undo window)

## Symptom

Undo/redo is asynchronous: files are restored, then `markUndoRecordRedone` and
`loadHistory` run, and only then is `UNDO_RECORD_UPDATED` emitted, carrying just
`target` and `undoRecord`. The webview applies it unconditionally
(`setUndoRecord` / `updateHistoryStepUndoRecord`). If the user switches to another
workflow or run in that window, the record lands on the step with the same index
in the new view. That step then shows as undone or redone when it isn't. This is
the same class of bug as the fixed `step-undo-data-not-workflow-scoped.md`.

## Suggested Fix

Add `workflowKey` and `runRef` to `UndoRecordUpdatedMessage` (the coordinator
already has both in `recordUndoApplied`/`recordRedoApplied`). Drop the message in
the handler unless it matches the applied view address.
