# Failed commit checkout is silently swallowed; the comment says refresh surfaces it but refresh is never called

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/ui/webview-react/hooks/useCommitHistoryContextMenu.tsx`
- **Resolution:** fixed in this commit

## Symptom

In the hosted workspace viewer's commit history, a confirmed "Checkout Commit (Detach HEAD)" can fail on the server, for example when git refuses because uncommitted local changes would be overwritten. When that happens the modal closes and nothing else happens: no error message, no log line, no refresh. The user gets no sign that the checkout did not happen.

The "Return to branch" action in `WorkspaceCommitHistoryPane` swallows its errors the same way.

## Steps to Reproduce

1. Open the hosted dashboard's workspace viewer on a git repo.
2. Edit a tracked file so the change conflicts with that file's contents in an older commit, and leave it uncommitted.
3. In the commit history pane, right-click the older commit, choose "Checkout Commit (Detach HEAD)", then click Checkout in the confirm modal.
4. The server's `git checkout <hash>` fails with "Your local changes ... would be overwritten", and the server returns HTTP 500 with that message.
5. Observe: the modal closes, nothing tells the user about the error, the history does not refresh, and HEAD stays on the branch with no explanation.

## Root Cause

`src/ui/webview-react/hooks/useCommitHistoryContextMenu.tsx:52-77`: `handleCheckoutCommit` calls `onRefresh()` only on the success path (line 71). Its catch block (lines 72-74) is empty except for the misleading comment `// errors surfaced via refresh`, so the `HostedHttpError` thrown by `hostedFetch` (`src/ui/webview-react/utils/hostedApi.ts:93-98`) is discarded. The confirm modal was already closed by `handleConfirmCheckout` (line 131) before the request started, so nothing on screen reflects the failure.

The server does pass git's failure through: `src/server/CtrlYokeHostedServer.ts:2200-2205` returns a 500 with `{ error: message }`, where the message comes from the `git checkout` call in `src/server/HostedWorkspaceViewerService.ts:2628`. The client just never shows it.

The same pattern is in `src/ui/webview-react/components/workspace-viewer/WorkspaceCommitHistoryPane.tsx:763-765` for `checkoutBranch` (Return to branch), whose comment claims "the parent status refresh remains the source of truth for failures" even though no refresh runs on failure.

## Suggested Fix

- In the catch block, log the error with `WebviewLog` and show it to the user: an inline error state or banner in the commit history pane, or a notification if the dashboard has one. Use the `HostedHttpError` message, preferably after parsing the JSON `{ error }` body instead of showing the raw `HTTP 500: {...}` text.
- Call `onRefresh()` in a `finally` block (or in the catch too) so the view resyncs with the real repo state.
- Remove the misleading comments.
- Apply the same fix to the Return-to-branch handler in `WorkspaceCommitHistoryPane.tsx`, ideally through one shared helper for workspace-viewer git mutations.
- Add a Vitest test that mocks `workspaceCheckoutCommit` to reject and asserts that the error is shown.
