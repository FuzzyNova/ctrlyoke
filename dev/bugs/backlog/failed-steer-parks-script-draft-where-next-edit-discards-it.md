# A failed queued-step steer parks the script draft where the next edit discards it

- **Found:** 2026-11-25 by bug-hunt final step (review of dcdd02a45, store probe)
- **Area:** `src/ui/webview-react/store/editorStore.ts`, `src/ui/webview-react/components/editor/StepEditor.tsx`
- **Severity:** medium (silent loss of a user-typed script command; the fix in dcdd02a45 is incomplete)

## Symptom

dcdd02a45 fixed `move-to-editor-discards-new-step-script-draft.md` for the
failed **Send as Steer** path by keeping the replaced script draft in
`savedNewPromptState` (`moveStepToNewStepDraft(..., false, true)`,
`editorStore.ts` around lines 939-975). The editor is left in **new-prompt**
mode holding the restored step, so `savedNewPromptState` is a slot nothing in
new-prompt mode reads back. The draft is invisible, and the next ordinary
editor action destroys it:

- Selecting any step: `enterEditMode` (`editorStore.ts` ~793-796) overwrites
  `savedNewPromptState` with `captureNewStepDraft(state)` (the restored step)
  because the current target is new-prompt. Returning to new-prompt mode
  restores the steered text; the script command is gone.
- Anything that calls `enterNewPromptMode` while already in new-prompt mode
  swaps the parked script draft in and silently drops the restored steer text
  instead.

`docs/guide/dashboard.md` (step menu, **Send as Steer** row) now promises "If
delivery fails, it restores the step in the editor and preserves any replaced
prompt or script draft."

## Steps to Reproduce

Store-level probe (vitest, `src/ui/webview-react/test/store/`):

```ts
store().resetEditor();
store().setStepType(STEP_TYPES.SCRIPT);
store().setScriptCommand("npm run deploy -- --prod");
store().moveStepToNewStepDraft(0, { prompt: "queued" }, false, true); // failed steer restore
store().enterEditMode(1, { prompt: "other" });
store().enterNewPromptMode();
// stepType "prompt", scriptCommand "", promptText "queued" — the script is lost
```

In the UI: type a script command in a new Script step, right-click a pending
prompt step → **Send as Steer** to a session whose delivery fails, then click
any step in the queue and come back.

## Root Cause

`savedNewPromptState` means "the new-prompt draft while an existing step is
being edited". Storing a second new-prompt draft there while the editor is
itself in new-prompt mode breaks that invariant, and the existing test
(`editorStore.test.ts`, "keeps a replaced script draft when restoring a failed
steer") only checks that the field is set, not that the draft can be
recovered.

## Suggested Fix

Do not keep two new-prompt drafts. On the failed-steer restore, when the
draft being replaced is a non-empty script draft, leave the script draft in
the editor and keep the steered step's prompt text in Recent Prompts
(`usePromptHistoryStore.getState().rememberDraft`) with a toast saying where
it went; otherwise restore as today. Drop the `preserveReplacedScriptDraft`
parameter, update the docs row, and replace the existing test with one that
follows the draft through a later `enterEditMode`/`enterNewPromptMode` round
trip.
