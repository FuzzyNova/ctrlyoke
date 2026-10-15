# Attachment token-count refs stay pending forever when a request or response is lost

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/ui/webview-react/hooks/useAttachmentTokenCount.ts`
- **Resolution:** fixed in this commit

## Symptom

If one attachment-token-count request is lost, the refs in it are never requested again for the rest of the page's life. The request can be lost because `standalone-shim.js` dropped it while the hosted socket was reconnecting, or because it was in flight when the extension host restarted. This applies to every `@file`, selection, symbol or git-change ref in that request. The prompt editor's token estimate counts each of those refs as 0, so the total stays too low until a full page reload.

## Steps to Reproduce

1. Open the hosted dashboard in a mobile browser, or in any browser with DevTools network throttling, and open a prompt editor.
2. Drop the WebSocket briefly by backgrounding the tab or toggling offline. While it is down, type a new reference such as `@src/extension.ts` and wait more than 250 ms so the debounced `REQUEST_ATTACHMENT_TOKEN_COUNTS` is posted. The shim drops it with a warning.
3. Let the socket reconnect. The token estimate does not include the file's tokens.
4. Remove the ref and type it again, or reference the same file in another step. No new request is ever sent for `@src/extension.ts` because it is filtered out at `useAttachmentTokenCount.ts:226`. It keeps counting as 0 until the page is reloaded.

## Root Cause

At `src/ui/webview-react/hooks/useAttachmentTokenCount.ts:231`, each ref that is not a prior-context ref is added to the module-level `pendingRequests` set (declared at `:40`) before `sendMessage` runs (`:234`). Refs are removed from the set only at `:77`, in the global `ATTACHMENT_TOKEN_COUNTS_RESPONSE` listener, and only when they appear in `message.counts`. The request filter at `:226` (`!attachmentTokenCache.has(ref) && !pendingRequests.has(ref)`) then excludes any ref left in the set. There is no timeout, retry, reconnect reset or retirement, so the exclusion is permanent.

`standalone-shim.js` drops outbound messages on purpose while the socket is down (`.github/instructions/server.instructions.md:43`, `.github/instructions/webview-react-hooks.instructions.md:21`). A request sent during that window is never answered. The same instructions require every client-owned request/response pair to reissue and then retire, and this hook does neither.

The backend has two related gaps in `src/ui/PromptEditorSupportService.ts`:

- `handleAttachmentTokenCountRequest` replies with `counts: {}` when there is no workspace root (`:1493-1499`). Every ref in that request stays pending.
- The setup code at `:1503-1515` (the trusted-roots lookups and `getViewSourceDefinitionDir`) is outside the per-ref `try/catch`. If it throws, the handler sends no response.

## Suggested Fix

- Change `pendingRequests` from a bare `Set` to something that records when each ref was requested or how many times, e.g. `Map<string, number>` holding the request time. In the request filter, stop treating a ref as pending once it is older than a few seconds, so a later render or a reissue interval sends it again. Cap the attempts, then retire the ref by caching 0. This follows the reissue-and-retire rule in `webview-react-hooks.instructions.md:21`; `useRunViewLoadWatchdog` is the worked example.
- As a simpler extra step, clear `pendingRequests` when the hosted socket reconnects or the extension host restarts.
- On the backend, make `handleAttachmentTokenCountRequest` answer every ref it was asked about: return 0 for each ref in the no-workspace branch, and wrap the setup at `:1503-1515` in `try/catch` so a response is always sent.
- Add a Vitest case that sends a request, never answers it, advances the timers and asserts that the ref is requested again.
