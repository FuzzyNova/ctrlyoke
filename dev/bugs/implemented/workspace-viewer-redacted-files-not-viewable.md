# Hosted workspace viewer shows nothing for files flagged as containing secrets

- **Found:** 2026-10-02 by bug-hunt final step (claude-cli), reproduced in a scratch Vitest against `WorkspaceExplorerPane`
- **Area:** `src/ui/webview-react/components/workspace-viewer/WorkspaceExplorerPane.tsx` (`openFile` ~268-293)
- **Resolution:** fixed in this commit

## Symptom

Since c0612c130, `HostedWorkspaceViewerService` returns credential-looking files with
redacted `content`, `readOnly: true` and the reason "File contains secrets and cannot
be edited in the hosted viewer". The intent was view-only. The client ignores `content`
whenever `readOnly` is set, so only the reason message is shown. Any `.env` or config
file, or source file with a key-like string, can no longer be viewed at all.

## Root Cause

`openFile` calls `setFileReadOnly(true, result.reason)` and never loads
`result.content`. That branch was written for binary, too-large and not-found files,
which have no content.

## Suggested Fix

When `readOnly` arrives _with_ a string `content`, load it and render the editor
read-only (no save, banner showing the reason). Keep the placeholder for responses
without content. Check that the store/editor support a read-only-with-content state
(e.g. the CodeMirror `readOnly` facet) and that Save is disabled. Add a Vitest.
