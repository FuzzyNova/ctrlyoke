# SCM file diff loads are not request-sequenced, so a late response shows the wrong file's diff

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/ui/webview-react/components/workspace-viewer/WorkspaceSourceControlPane.tsx`
- **Severity:** low

## Symptom

In the Source Control pane, the diff pane header names the currently selected file (B) but the body shows the diff of a file selected earlier (A) when A's diff response arrives after B's. While B's request is still pending, the loading spinner can also disappear early and show stale content.

## Steps to Reproduce

1. Open the workspace viewer's Source Control pane in a repo with a large changed file A (slow diff) and a small changed file B.
2. Click A in the Changes list, then quickly click B before A's diff finishes loading.
3. B's `/api/workspace-viewer/diff` response arrives first and B's diff renders; then A's response arrives and calls `setDiffData` with A's content.
4. Observe: the selected file and pane header still show B, but the diff body shows A's old and new content until the user clicks again.

## Root Cause

- `WorkspaceSourceControlPane.tsx:193-215`: `selectFileDiff` awaits `workspaceDiff(filePath)` (line 199), then calls `setDiffData(result)` (line 200) and, in `finally`, `setDiffLoading(false)` (line 204). It never checks that this request is still the latest one or that `selectedDiffPath` still equals `filePath`. An earlier request's `finally` therefore also clears `diffLoading` while a newer request is pending.
- `workspaceViewerStore.ts:808-820`: `setDiffData` writes the content without checking the path. `selectDiff` (line 766) does not clear `diffOldContent`/`diffNewContent`, so the previous file's content stays visible once loading is cleared.
- `hostedApi.ts:190-196`: `workspaceDiff` is a plain, unsequenced fetch.
- `WorkspaceDiffPane.tsx:484-514` renders whatever content is stored under `selectedDiffPath`.
- Other entry points start concurrent loads through the same function: the `pendingDiff` consumer (`WorkspaceSourceControlPane.tsx:218-223`) and `refreshAfterMutation` (line 244 onward).

The explorer pane already guards against this exact race with `fileLoadRequestSeqRef`/`isCurrentRequest` (`WorkspaceExplorerPane.tsx:175, 307-325`); the SCM pane has no equivalent.

## Suggested Fix

Add a request-sequence ref to `selectFileDiff`, following the explorer pane's `fileLoadRequestSeqRef`/`isCurrentRequest` pattern. Increment it on each call; after the await, return early unless the sequence still matches the latest request and `useWorkspaceViewerStore.getState().selectedDiffPath === filePath`. Apply the same check in `catch` (`setScmError`) and `finally` (`setDiffLoading(false)`), so a superseded request neither overwrites content nor clears the loading flag.

Optionally, have `setDiffData` take the path and ignore responses for a path that is no longer selected, as a store-level backstop.

Add a Vitest test that resolves two `workspaceDiff` promises out of order and asserts the store holds the later file's content and that `diffLoading` stays true until the latest request settles.
