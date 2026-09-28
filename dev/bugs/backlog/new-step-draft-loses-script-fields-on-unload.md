# A new-step draft loses its step type, script fields and disabled state when the workflow is unloaded

- **Found:** 2026-09-28 by lots-of-bug-fixes final step (Claude)
- **Area:** `src/ui/webview-react/store/editorStore.ts`, `src/ui/webview-react/hooks/useMessageHandler.ts`
- **Severity:** medium

## Symptom

The `WORKFLOW_UNLOADED` handler saves the new-step draft and then calls `cancelEdit()`; its
comment says this pair preserves "whatever the user has typed". Only part of the draft survives:

- A new **script** step draft (step type `script`, command `npm test`, timeout, operator, etc.)
  comes back as an empty **prompt** step. The typed command is lost.
- A prompt draft with **Enabled** turned off comes back enabled.

Prompt text, name and properties do survive.

## Steps to Reproduce

1. In the dashboard editor's new-step mode, switch the step type to Script and type `npm test`.
2. Trigger `WORKFLOW_UNLOADED` (for example, close or switch away from the workflow).
3. The editor now shows a prompt step with an empty command.

In vitest (with a `getVsCodeApi` mock whose `getState`/`setState` really store the value, as
VS Code does): set `stepType: script`, `scriptCommand: "npm test"`, `stepEnabled: false` in
new-step mode, dispatch `WORKFLOW_UNLOADED`, and observe `stepType: prompt`, `scriptCommand: ""`,
`stepEnabled: true`.

## Root Cause

- `saveToVsCodeState` (around line 1223) persists only `editorText`, `promptName`,
  `stepEnabled` and `properties`. It drops `stepType` and every `script*` field.
- The restored branch of `cancelEdit` (around lines 748-770) then unconditionally sets
  `stepType: PROMPT`, `stepEnabled: true`, `scriptCommand: ""` and resets every other script
  field, overwriting even the `stepEnabled` value that `restoreFromVsCodeState` just restored.

## Suggested Fix

Persist `stepType` and the script fields in `saveToVsCodeState` and restore them in
`restoreFromVsCodeState`, ideally from one shared list of draft fields (the same fields
`savedNewPromptState` already carries) so the two cannot drift. Make the restored branch of
`cancelEdit` only clear the edit-mode flags (`selectionTarget`, `selectedPromptIndex`,
`originalPromptData`, `savedNewPromptState`, `validationErrors`, `pendingEdits`) and not reset
the draft content. Add a vitest test with a stateful VS Code API mock.
