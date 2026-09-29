# The prompt editor keeps a stale step index after steps are deleted, inserted or reordered, so Update can overwrite a different step

- **Found:** 2026-09-28 by lots-of-bug-fixes final step (Claude)
- **Area:** `src/ui/webview-react/store/editorStore.ts`, `src/ui/webview-react/hooks/useMessageHandler.ts`
- **Resolution:** fixed in this commit

## Symptom

The editor's `selectionTarget` and its unsaved drafts (`pendingEdits`, keyed `queue:<index>`) are
indexed by position. When the step list changes underneath them, nothing remaps them, so:

- **Wrong step overwritten.** With steps first–fourth, select index 2 ("third") in the editor.
  Delete step 0 from the step's context menu. The editor still shows "third", but its target
  index 2 is now "fourth". Pressing Update sends `UPDATE_PROMPT {index: 2}` and overwrites
  "fourth" with "third"'s text.
- **Draft moves to another step.** Edit index 1 without saving, switch to index 3, then delete
  step 0. Selecting the new index 1 (the old "third") shows the old draft for "second" and marks
  it dirty.

Paths that can trigger it:

- context-menu Delete (`useStepContextMenu.tsx` `handleDeleteStep` and `handleDeleteConfirm`,
  which never call `cancelEdit`)
- Paste Step inserts
- grouping and fail-fast reorders
- any step change made by another client (MCP `append_step`/`remove_step`/`reorder_steps`, or
  another dashboard)

Drag-reorder and the editor's own Delete call `cancelEdit()`, which only clears the current
target's draft, so other `queue:*` drafts still go stale.

## Steps to Reproduce

1. Load a workflow with four prompt steps and select step 3 in the editor.
2. Right-click step 1 and choose Delete.
3. Change the text in the editor and press Update. The step that was previously 4th is overwritten.

## Root Cause

The `PROMPT_DELETED` (around line 1084), `STEPS_EXTENDED` (around line 947) and
`REORDER_PROMPTS_CONFIRMED` (around line 1056) handlers in `useMessageHandler.ts` update the
workflow store but never touch `useEditorStore`. `UPDATE_PROMPT` is addressed purely by index
(`PromptEditor.tsx`, around line 1292).

## Suggested Fix

Fix this in the message handlers, which every sender goes through, rather than in each sender.
Remap `selectionTarget` and every `queue:<index>` key in `pendingEdits` through the change
(delete, insert or reorder). If the selected step itself was removed, cancel the edit. Put the
remapping in one editor-store action shared by all three handlers. Add vitest coverage for delete
before, at and after the selection; for insert; and for reorder.
