# Hosted workspace viewer: a slow file response overrides the file opened after it

- **Found:** 2026-10-02 by bug-hunt final step (claude-cli), reproduced in a scratch Vitest with deferred `workspaceFile` responses
- **Area:** `src/ui/webview-react/components/workspace-viewer/WorkspaceExplorerPane.tsx` (`openFile` ~268-293)
- **Resolution:** fixed in this commit

## Symptom

Open `big.bin` (a slow response), then quickly open `b.ts`. When `big.bin`'s response
(`readOnly: true, reason: "Binary file"`) arrives last, `b.ts` stays selected but is
shown as "Binary file" with no editor. If the late response is a normal text file,
`setLoadedFileContent(A, ...)` switches the selection back to A even though B was
clicked last. The late response's `finally` also clears B's loading state too early.

## Root Cause

`openFile` applies whatever `workspaceFile` returns, without checking that the
response still belongs to the latest request.

## Suggested Fix

Keep a request-sequence ref and drop stale responses (including their loading and error
updates). Add a Vitest with two deferred responses resolved out of order.
