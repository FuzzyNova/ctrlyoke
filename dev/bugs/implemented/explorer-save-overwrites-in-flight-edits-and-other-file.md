# Explorer save overwrites edits made while the save request is in flight, and can write the saved file's content into a different file

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/ui/webview-react/components/workspace-viewer/WorkspaceExplorerPane.tsx`
- **Resolution:** fixed in this commit

## Symptom

In the hosted workspace viewer's Explorer editor, text typed while a save is in flight disappears when the save completes. The file shows as clean, the draft is gone, and undo cannot bring the text back.

If the user switches to another file before the save returns, that file's editor is replaced with the saved file's text and marked clean, and its unsaved draft is deleted. A later save of that file normally fails with a conflict (409). If the user then chooses "keep local" and saves again, the other file's content is written into it on disk.

## Steps to Reproduce

1. Open the hosted dashboard workspace viewer (Explorer tab) and open a text file. A remote or throttled connection widens the timing window.
2. Edit the file, press Ctrl+S, and keep typing straight away, before the save PUT returns.
3. When the save resolves, the characters typed after Ctrl+S vanish, the dirty indicator clears, and Ctrl+Z does not restore them.
4. Variant: edit file B without saving (a draft now exists), switch to file A, edit it, press Ctrl+S, then click file B in the explorer before the save returns.
5. Once the save resolves, B's editor shows A's text (or, if B's load lands later, B's disk content), B is marked clean, and B's unsaved draft is gone. `modifiedAtRef` now holds A's mtime, so the next save of B gets a 409 conflict, and "keep local" followed by another save writes the wrong content into B.

## Root Cause

- `src/ui/webview-react/components/workspace-viewer/WorkspaceExplorerPane.tsx:563-591`: `handleSave` captures `fileContent` and `selectedFilePath` when the save starts. After `await workspaceSaveFile(...)` it sets `modifiedAtRef.current = result.modifiedAt` (line 572) and calls `markFileSaved(fileContent)` (line 574) without checking that the selected file and its content are still the ones that were saved.
- `src/ui/webview-react/store/workspaceViewerStore.ts:655-673`: `markFileSaved` applies the passed content to the file selected *now*. It overwrites `fileContent` and `originalFileContent`, clears `fileDirty`, and deletes that path's draft.
- `src/ui/webview-react/components/workspace-viewer/WorkspaceFileEditor.tsx:642-655`: the content-sync effect pushes the stale snapshot into CodeMirror with `Transaction.addToHistory.of(false)`, so the change cannot be undone.
- The editor is not locked during a save. The `saving` prop (`WorkspaceFileEditor.tsx:123`) is declared but unused. `selectFile` (`workspaceViewerStore.ts:478`) switches files immediately. Saves have no request-sequence guard like the `fileLoadRequestSeqRef` guard that `openFile` uses.

## Suggested Fix

- Make `markFileSaved` path- and content-aware, e.g. `markFileSaved(path, savedContent)`. Change the store only when `selectedFilePath === path`. Set `originalFileContent = savedContent`, recompute `fileDirty = fileContent !== savedContent`, and leave `fileContent` alone. Delete the draft only when it equals `savedContent`; otherwise keep it.
- In `handleSave`, capture `const savedPath = selectedFilePath; const savedContent = fileContent;`. After the await, update `modifiedAtRef.current` only if the store's `selectedFilePath` still equals `savedPath`. If the user has switched away, keep the returned mtime in a per-path map instead of the single ref.
- Ignore Ctrl+S while a save is already in flight (check `fileSaving` in `handleSave`).
- Add Vitest coverage for both cases: typing during an in-flight save, and switching files during an in-flight save.

## Decision

A save completion updates the selected editor only when its path still matches the saved path; otherwise its returned modification time is retained by path and consumed when that file is opened again.
