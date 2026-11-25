# Queued step "Send as Steer" overwrites the editor on failure and ignores unsaved edits

- **Found:** 2026-11-25 by bug-hunt workflow final step (Claude subagent, code trace)
- **Area:** `src/ui/webview-react/utils/stepContextMenuItems.ts` (`buildQueuedStepHandoffMenuItems` ~294-370), `src/ui/webview-react/components/editor/StepEditor.tsx` (~861-875), `src/ui/WorkflowStepHandlers.ts` (~100-125)
- **Resolution:** fixed in this commit

## Symptom

Two problems with the pending-step context-menu item **Send as Steer** (landed in
648c83198):

1. **A failed steer overwrites the editor.** If delivery fails, the step's text
   replaces whatever is in the prompt editor. An unsent draft is lost (it is not
   saved to Recent Prompts). If the editor was editing another step, that step's
   editor now holds the steered step's text, and pressing Update saves it into
   the wrong step.
2. **Unsaved edits to the step are dropped.** The steer sends the step's saved
   `prompt`. If the user had edited the step in the editor without saving, those
   edits are never sent and are discarded when the step is deleted.

## Steps to Reproduce

Failure path:
1. Type an unsent draft in the prompt editor (or select step 5 and edit it
   without saving).
2. Right-click pending step 3 → Send as Steer.
3. The target session ends before delivery (e.g. its step finishes between
   opening the menu and clicking), so `sendSteerMessage` throws "No live harness
   session".
4. The editor now shows step 3's prompt. The draft is gone and not in Recent
   Prompts.

Unsaved edits:
1. Select pending step 2 and change its text without saving.
2. Right-click step 2 → Send as Steer.
3. The old saved text is steered; the edit is discarded.

## Root Cause

- `steerTo` in `stepContextMenuItems.ts` (~332-336) calls
  `sendSteerText(workflowId, target.sessionId, steerText)` and immediately
  `removeStep()`. It never touches the editor.
- On failure, `WorkflowStepHandlers.ts` (~113-119) emits
  `EXECUTE_PROMPT_ERROR` with `text: message.text`.
- `StepEditor.tsx` (~864-870) handles that by calling `setPromptText(restored)`
  unconditionally. That was written for sends from the editor, where the editor
  was already cleared on dispatch, so overwriting was harmless. A queued-step
  steer leaves the editor's content in place, so it gets clobbered.
- `steerText` is `step.prompt.trim()` (~319), the saved definition. Move to
  Editor, right beside it, goes through `moveStepToNewStepDraft`, which honours
  the live editor text and `pendingEdits`. After `DELETE_PROMPT`,
  `remapStepTargets` in `editorStore.ts` drops the removed step's
  `pendingEdits` entry (and `cancelEdit()` if it was selected).

The handoff's own doc comment (`stepContextMenuItems.ts` ~288-292) says the text
"is not lost ... a failed steer is restored into the editor", which is why the
delete confirmation is skipped.

## Suggested Fix

- Compute the steer text the way Move to Editor does: the live editor text if
  the step is the current `selectionTarget`, otherwise
  `pendingEdits[queue:i].promptText`, otherwise `step.prompt`.
- Restore a failed queued-step steer without destroying the editor. For example,
  tag the steer request/error with its origin, and for a queued-step origin
  restore through the same path as `moveStepToNewStepDraft` (remember the
  replaced draft in Recent Prompts, then load the text as a new-step draft).
- Vitest coverage: a draft in the editor plus a steer item's onClick, then
  dispatch `EXECUTE_PROMPT_ERROR`; assert the draft is in
  `usePromptHistoryStore` and an edit in progress on another step is not
  overwritten. Plus a test that unsaved edits are what gets steered.
