# Snapshot-content request never times out, and the stuck promise is cached for good

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/ui/webview-react/hooks/useWorkspaceSnapshotContent.ts`
- **Severity:** medium

## Symptom

On the hosted dashboard, clicking Undo/Redo or opening the prompt/workflow changes view sometimes does nothing and shows no error. This affects steps whose snapshot has `contentAvailableOnDemand` files. It happens when the WebSocket was down at the moment the content request was posted, or at the moment its reply came back. After that, every click on the same step and file also does nothing until the page is fully reloaded. Each lost request also leaves a window `message` listener attached.

## Steps to Reproduce

1. Run a workflow whose step changes files large enough that the snapshot index marks them `contentAvailableOnDemand`.
2. Open the hosted dashboard in a browser (for example on a phone). Close the WebSocket without reloading the page, either by setting the network offline in devtools or by backgrounding the tab.
3. While the socket is down, click Undo (or open the prompt/workflow changes view) on that step's output row. The shim logs `dropped outbound message while disconnected type=requestWorkspaceSnapshotContent`.
4. Restore the network and let the shim reconnect without reloading.
5. Click the same Undo again. No request is sent because the pending promise for that key is returned, and the dialog never opens. Only a full page reload recovers.

## Root Cause

- `src/ui/webview-react/hooks/useWorkspaceSnapshotContent.ts:49-79`: the promise is resolved only by the message listener. It has no timeout, no reject path and no reissue.
- Line 88 stores the promise in `pending`. The only removal is at line 76, and it runs only when a matching reply arrives.
- Line 46 returns the stuck promise to every later caller with the same `(workflowKey, runRef, target, path)` key, so that key stays broken until reload.
- `src/server/standalone-shim.js:780-801` drops outbound non-READY messages while the socket is not OPEN. This is by design (see `webview-react-hooks.instructions.md`), and it means lost requests are a normal event. A reply sent during a reconnect gap is lost the same way.
- The callers await the promise with no fallback: `src/ui/webview-react/hooks/useOutputUndoActions.ts:318`, `:360`, `:436` and `:511` (`openMinimapDialog`, `handlePromptViewMeta`, `handleFileUndo` and `handleWorkflowView`), plus `src/ui/webview-react/components/output/OutputRow.tsx:700`.
- Minor: `src/ui/WebviewMessageRouter.ts:1692-1699` returns without replying when payload validation fails. The hooks instructions require a backend handler to answer on every path.

## Suggested Fix

- Follow the request/response pattern in `webview-react-hooks.instructions.md`, using `useRunViewLoadWatchdog` as the model:
  - While the request is unanswered, reissue it on an interval with the same `requestId`.
  - Cap the total number of attempts.
  - After the cap, remove the listener, delete the `pending` entry, and either reject or resolve with a failure marker.
- Have the `hydrateSnapshot` callers show a toast on failure instead of hanging silently.
- Clear `pending` on every terminal path, so a key is never left broken and a later click starts a fresh request.
- In the router's validation-failure branch, send a `WORKSPACE_SNAPSHOT_CONTENT` reply with no content whenever a string `requestId` is present, so a malformed request still settles.
- Add tests for two cases:
  - A dropped request is reissued and eventually rejected.
  - A retry after giving up sends a new request.
