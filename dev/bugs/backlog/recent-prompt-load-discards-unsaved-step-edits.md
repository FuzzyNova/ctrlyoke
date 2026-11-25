# Loading a Recent Prompt while editing an existing step discards its unsaved edits

- **Found:** 2026-11-25 by bug-hunt final step (claude-cli subagent, failing vitest written)
- **Area:** `src/ui/webview-react/store/editorStore.ts`
- **Severity:** medium (silent loss of user-typed text)

## Symptom

With a pending step selected and its text edited but not yet updated, picking
an entry from the editor's **Recent Prompts** menu replaces the edit. The
edited text is not added to Recent Prompts, and Cancel or re-selecting the
step restores only the saved text.

`docs/guide/prompt-editor.md` (Recent prompts section) says: "If the editor
holds unsent text, that text is added to the list before it is replaced, so you
can switch back to it."

## Steps to Reproduce

1. Select a pending step and change its text without pressing Update.
2. Right-click in the editor → **Recent Prompts** → pick an entry.
3. The edit is gone and is not in Recent Prompts.

Failing vitest:

```ts
store().enterEditMode(0, { prompt: "saved text" });
store().setPromptText("unsaved careful edit");
store().loadRecentPrompt("earlier prompt");
store().cancelEdit();
store().enterEditMode(0, { prompt: "saved text" });
// promptText "saved text"; prompt history has no "unsaved careful edit"
```

## Root Cause

`loadRecentPrompt` (`editorStore.ts:~967-973`) only calls
`rememberReplacedPromptDraft` in new-prompt mode. Its reasoning ("an existing
step's text is still in the step") holds for the saved text only, not for
unsaved edits. The existing test (`src/ui/webview-react/test/**/editorStore.test.ts`,
the Recent Prompt edit-mode case) only covers an unedited step.

## Suggested Fix

In edit mode, when the editor is dirty and `promptText` differs from
`originalPromptData.prompt`, call
`usePromptHistoryStore.getState().rememberDraft(state.promptText)` before
replacing it. Update the comment and add a test for the dirty edit-mode case
(and keep the existing clean-edit test asserting nothing is remembered).
