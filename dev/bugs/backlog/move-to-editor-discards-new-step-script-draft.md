# Move to Editor (and a failed Send as Steer) permanently discards a new-step script draft

- **Found:** 2026-11-25 by bug-hunt final step (claude-cli subagent, failing vitest written)
- **Area:** `src/ui/webview-react/store/editorStore.ts`
- **Severity:** medium (silent loss of user-typed text)

## Symptom

If the prompt editor's new-step draft is a **script** draft, choosing **Move
to Editor** on a pending step replaces it, and the script command is not kept
anywhere: not in the editor, not in `savedNewPromptState`, not in Recent
Prompts. The same happens when the user is editing another step and the saved
new-step draft (`savedNewPromptState`) is a script draft, and when a queued
step's **Send as Steer** fails and the step is restored into the editor.

`docs/guide/dashboard.md` (step menu table, **Move to Editor** row) promises
"Unsent text it replaces is kept in Recent Prompts", and the action skips any
confirmation on that basis.

## Steps to Reproduce

1. In the prompt editor, new-step mode, switch the step type to Script and type
   `npm run deploy -- --prod`.
2. Right-click a pending prompt step → **Move to Editor**.
3. The editor holds the moved step; the script command cannot be recovered.

Failing vitest (store level):

```ts
store().resetEditor();
usePromptHistoryStore.setState({ entries: [] });
store().setStepType(STEP_TYPES.SCRIPT);
store().setScriptCommand("npm run deploy -- --prod");
store().moveStepToNewStepDraft(0, { prompt: "queued prompt" });
// stepType prompt, scriptCommand "", savedNewPromptState null, history []
```

## Root Cause

- `rememberReplacedPromptDraft` (`editorStore.ts:~400-406`) returns early
  unless `draft.stepType === STEP_TYPES.PROMPT`; its comment says a script
  draft "is left alone".
- `moveStepToNewStepDraft` (`editorStore.ts:~937-965`) then overwrites the
  whole draft via `enterEditMode` and sets `savedNewPromptState: null`, so the
  script draft is destroyed rather than left alone.
- Callers: `stepContextMenuItems.ts` (Move to Editor) and the
  `EXECUTE_PROMPT_ERROR` handler in `StepEditor.tsx` (failed queued-step
  steer).

## Suggested Fix

Do not destroy a non-empty script draft. Options, simplest first:

- Disable **Move to Editor** (with a disabled reason) and, for the steer
  failure path, keep the draft in `savedNewPromptState` instead of nulling it,
  when the draft being replaced is a non-empty script draft; or
- Ask for confirmation before replacing it; or
- Extend Recent Prompts to hold script commands as their own entry kind.

Add store tests for both entry points (Move to Editor while in new-step mode,
and while editing another step with a script `savedNewPromptState`) and update
the docs row if the behavior changes.
