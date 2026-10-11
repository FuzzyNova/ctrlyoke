# Workspace viewer Explorer deletes files and folders with no confirmation

- **Found:** 2026-10-11 by Claude (workspace viewer docs pass, code review)
- **Area:** `src/ui/webview-react/hooks/useWorkspaceExplorerContextMenu.tsx`, `src/server/HostedWorkspaceViewerService.ts`
- **Severity:** high

## Symptom

In the hosted dashboard's workspace viewer, **Delete** on the Explorer's
right-click (or long-press) menu permanently deletes the file, or the folder and
everything in it, immediately. There is no confirmation, the Recycle Bin/Trash
isn't used, and nothing can undo it. A mistaken long-press on a phone is enough.

`ui.confirmDeleteOperations` (default `true`) promises "a confirmation dialog
before delete operations", and Source Control's discard of untracked files
honours it, but Explorer Delete doesn't.

## Steps to Reproduce

1. Open the hosted dashboard, then **Explore files and changes** → **Explorer**.
2. Right-click a folder and select **Delete**.
3. The folder is gone from disk at once.

## Root Cause

`handleDelete` in `useWorkspaceExplorerContextMenu.tsx:100-112` calls
`workspaceDeleteEntry` directly, and `HostedWorkspaceViewerService.deleteEntry`
(`HostedWorkspaceViewerService.ts:1471-1480`) runs
`fs.promises.rm(resolved, { recursive: true })`.

## Suggested Fix

Show the same confirmation modal Source Control uses (with "Don't warn me
again" writing `ui.confirmDeleteOperations`), naming the entry and, for a folder,
saying its contents go too. Consider moving to the OS trash on the server side
(as VS Code does), with permanent delete as the fallback when trash isn't
available.
