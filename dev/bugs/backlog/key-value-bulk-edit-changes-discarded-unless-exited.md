# KeyValueRowsEditor discards bulk-edit changes unless 'Exit bulk edit' is clicked

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/ui/webview-react/components/shared/KeyValueRowsEditor.tsx`
- **Severity:** medium

## Symptom

Anything typed in a `KeyValueRowsEditor` bulk-edit textarea is silently lost unless the user clicks "Exit bulk edit" first. This affects MCP server env and headers, hook env, script env and workflow env. If the user saves the surrounding MCP server form while still in bulk mode, the server is saved with the env/headers it had before bulk mode. Switching the form's stdio/remote tab, or closing the panel or drawer that holds the editor, also throws the bulk text away. No warning is shown in any of these cases.

## Steps to Reproduce

1. Open the dashboard's MCP server add/edit form (`McpServerForm`) on the stdio tab and fill in an id and a command.
2. In the Environment editor, click "Bulk edit".
3. Type or paste `API_URL=https://x` and `TOKEN=${secret:T}` into the textarea.
4. Without clicking "Exit bulk edit", click the form's submit button (e.g. Add/Save).
5. Check the saved server config. It has no `env` entries, or only the entries from before bulk mode. The pasted variables are gone and no warning appeared.

## Root Cause

- The bulk textarea's `onChange` (`KeyValueRowsEditor.tsx:512-515`) only updates the local `bulkValueRef`/`bulkValue` state. It never calls the `onChange` prop.
- Only `exitBulkEdit` (`KeyValueRowsEditor.tsx:301-310`) parses the bulk text and commits it to the parent, and only the toggle button (`KeyValueRowsEditor.tsx:502`) calls it.
- The textarea has no `onBlur` handler, and no unmount effect flushes pending bulk text. The row inputs, by contrast, commit on blur (`KeyValueRowsEditor.tsx:414`, `559`).
- `McpServerForm` stores env/headers only in parent state, and that state changes only through this `onChange` (`McpServerForm.tsx:278-288`, `318-328`).
- The submit button (`McpServerForm.tsx:395-402`) calls `onSubmit`, which serializes `form.env`/`form.headers` through `mcpServerFormStateToServer` (`McpServerForm.tsx:121-159`). At that point those fields still hold the values from before bulk mode.

## Suggested Fix

Commit the bulk text to the parent without waiting for the toggle. Two options:

- **(a) Commit on every change.** On each textarea change, run `keyValueMapStringToObject(text)`. When it parses, pass the result to `commitRows`/`onChange` and stay in bulk mode. This matches how the row inputs commit.
- **(b) Commit on blur and unmount (minimum fix).** Give the textarea an `onBlur` that parses `bulkValueRef.current` and commits it through `commitRows`. Also add an unmount cleanup effect that flushes `bulkValueRef.current` while `isBulkEdit` is still true. This covers clicking Save too, because the textarea blurs on mousedown, before the button's click handler runs.

Either way, commit through `commitRows` so that `lastCommittedValueRef` is set. Otherwise the parent's echo of the committed value is treated as an external change.

Tests:

1. `KeyValueRowsEditor`: edit in bulk mode, then blur or unmount, and assert that `onChange` received the parsed record.
2. `McpServerForm`: click submit while still in bulk mode and assert that the saved `env` includes the new entries.
