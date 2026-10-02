# A prompt-type final step's name can't be cleared from the editor

- **Found:** 2026-10-02 by bug-hunt final step (claude-cli subagent), reproduced against `mergeWorkflowStepUpdate`
- **Area:** `src/ui/webview-react/components/editor/PromptEditor.tsx` (final-step branches of the save and `persistPromptFileReference` paths), `src/core/WorkflowStepSanitizer.ts` (`buildFinalStepUpdate`, `mergeWorkflowStepUpdate`)
- **Severity:** low

## Symptom

Edit a prompt-type `finalStep` that has a `name`, clear the name field, and save.
The name stays. Queue prompt steps and script final steps clear correctly.

## Steps to Reproduce

1. Workflow with `finalStep: { prompt: "Summarize the run", name: "Wrap-up" }`.
2. Select the final step in the dashboard editor, clear the name, and save.
3. The final step still shows "Wrap-up". `mergeWorkflowStepUpdate({prompt, name:"Wrap-up"}, {prompt}, [...clear without "name"])` returns the old name.

## Root Cause

- The editor's prompt-mode `UPDATE_FINAL_PROMPT` payloads (`PromptEditor.tsx` ~722-730 and ~1302-1310) omit `name` when it's empty.
- The `clearProperties` list from `getPropertyValues` never includes `"name"`.
- `buildFinalStepUpdate` drops an empty name too, so the same-kind merge in `mergeWorkflowStepUpdate` keeps the existing one.
- The script branch handles this correctly: it pushes `"name"` into `clearProperties` at ~1244.

## Suggested Fix

In both prompt-mode final-step branches, append `"name"` to `clearProperties`
when `promptName.trim()` is empty, as the script branch does. Add Vitest coverage
for the posted message, and Mocha coverage of `updateFinalStepInQueue` /
`updateFinalStepAtRun` clearing the name.
