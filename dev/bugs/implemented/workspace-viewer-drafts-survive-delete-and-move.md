# Hosted workspace viewer keeps unsaved drafts of deleted or moved files, and they resurface over new content

- **Found:** 2026-10-02 by bug-hunt final step (claude-cli), reproduced at store level in a scratch Vitest
- **Area:** `src/ui/webview-react/hooks/useWorkspaceExplorerContextMenu.tsx` (`handleDelete` ~97, `handlePaste` after Cut ~112-128), `src/ui/webview-react/store/workspaceViewerStore.ts` (`fileDrafts`)
- **Resolution:** fixed in this commit

## Symptom

1. Open `notes.md`, edit it without saving, then delete it from the explorer. The editor stays on the deleted path, and Save silently recreates the file.
2. When a new `notes.md` appears later (e.g. written by an agent), opening it shows the old draft marked dirty, and saving overwrites the new file.
3. After Cut and Paste of an edited file, the pasted file opens without the edits, and the draft stays stored under the old path.

## Root Cause

Delete and move in the context-menu hook never touch `useWorkspaceViewerStore`. Drafts
are keyed by path in `fileDrafts`, which persists across sessions.

## Suggested Fix

Add store actions to drop drafts at or under a deleted path, and to re-key them (and the
selection) when a path is moved. Call them from `handleDelete` and the Cut/Paste
handler. Clear the selection when the selected file is deleted. Add Vitest coverage.
