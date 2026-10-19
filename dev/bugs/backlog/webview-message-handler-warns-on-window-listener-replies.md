# Central webview MessageHandler warns "Unknown message type" for replies that window listeners consume

- **Found:** 2026-10-19 by Claude Code (log review)
- **Area:** `src/ui/webview-react/hooks/useMessageHandler.ts`
- **Severity:** low

## Symptom

Across the session logs in `.ctrlyoke/logs/`, the dashboard logged these warnings for request/response replies that were in fact handled:

```
1594  WARN: [panel] [MessageHandler] Unknown message type: workspaceSnapshotContent
  38  WARN: [panel] [MessageHandler] Unknown message type: branchListResponse
  15  WARN: [panel] [MessageHandler] Unknown message type: permissionCompletionsResponse
   3  WARN: [panel] [MessageHandler] Unknown message type: fileRefValidation
```

They come in bursts, one per reply. For example, in `ctrlyoke-1792346879606.log` from `2026-10-18T18:08:30.058Z` there is a run of `Unknown message type: workspaceSnapshotContent` lines, one for each snapshot diff the viewer requested. In the older logs `ctrlyoke-1791938273261.log` (176) and `ctrlyoke-1791903262722.log` (156) they make up a large share of all WARN lines.

Each warning is more than log noise. `WebviewLog.warn` forwards the line to the extension host as a `logMessage` message (`utils/logger.ts:46-47`). On the host, every webview message goes through the single serialized `routeQueue` in `WebviewMessageRouter.route` (`src/ui/WebviewMessageRouter.ts`, the `this.routeQueue = this.routeQueue.then(...)` block). So each snapshot-content reply costs one more queued route that every other client's messages wait behind.

## Steps to Reproduce

1. Open the workspace viewer and step through file snapshots or diffs (each one fetches `workspaceSnapshotContent`), open a branch-name field (`branchListResponse`), type in a permission-pattern field (`permissionCompletionsResponse`), or type a file reference in the prompt editor (`fileRefValidation`).
2. Check the session log. Each reply logs `WARN: [panel] [MessageHandler] Unknown message type: <type>`, even though the feature works.

## Root Cause

These replies are consumed by request-scoped `window.addEventListener("message", …)` listeners, outside the central handler table:

- `workspaceSnapshotContent`: `hooks/useWorkspaceSnapshotContent.ts:71-78`
- `branchListResponse`: `components/shared/BranchNameEditor.tsx:21-30`
- `permissionCompletionsResponse`: `components/shared/PermissionListEditor.tsx:53-62` and `utils/workflowFileSupport/hostedRangeCompletions.ts:24`
- `fileRefValidation`: `components/editor/PromptEditor.tsx:525-530`

The central listener in `useMessageHandler` (`hooks/useMessageHandler.ts:3530-3537`) also sees every `message` event, and it warns for any type missing from `createMessageHandlers()`. The file already works around this for other window-listener replies by registering explicit no-ops: `COMPLETIONS_RESPONSE`, `CONTEXT_REFS_VALIDATION`, `PASTED_IMAGE_SAVED`, `FILE_PREVIEW_URI_RESPONSE`, `DASHBOARD_HOST_ACTION_RESULT`, `ATTACHMENT_TOKEN_COUNTS_RESPONSE` and `EXECUTE_PROMPT_ERROR` (`useMessageHandler.ts:2376-2457`, each commented "so the central router doesn't log 'Unknown message type'"). `WORKSPACE_SNAPSHOT_CONTENT`, `BRANCH_LIST_RESPONSE`, `PERMISSION_COMPLETIONS_RESPONSE` and `FILE_REF_VALIDATION` were never added. Neither was `SCRIPT_COMPLETIONS_RESPONSE`, which `hostedRangeCompletions.ts` consumes the same way, so script-field completions will warn too.

(`recentWorkflowUpdated` also appears once in an older log, but it now has a real handler at `useMessageHandler.ts:1893`.)

## Suggested Fix

- Short term: register no-op handlers for the five types above next to the existing ones.
- Better, to stop it recurring: keep one typed `const` set of "reply types consumed by window listeners" (for example `WINDOW_LISTENER_REPLY_TYPES` in `DashboardConstants.ts`) and have the central handler skip it. Or check the `{request, response}` pairs that already exist (for example `REQUEST_TYPES` in `hostedRangeCompletions.ts`) so every new request/response pair is covered when it is declared. A unit test can assert that every `*_RESPONSE`/reply constant is either handled or in that set.
- Consider demoting the unknown-type log to DEBUG, or rate-limiting it, so a future gap cannot flood the host's route queue with forwarded log messages.
