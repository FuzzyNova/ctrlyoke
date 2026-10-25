# A dashboard completion request aborts the other completion source's in-flight request

- **Found:** 2026-10-24 by bug-drain review of 65ab2aef7
- **Area:** `src/ui/WebviewMessageRouter.ts`, `src/ui/PromptEditorSupportService.ts`
- **Resolution:** fixed in this commit

## Symptom

Typing `/` at the start of a dashboard prompt (the normal place for a slash
command) sometimes shows only paths, or only slash commands, never both. The
missing source's completion promise never resolves.

## Steps to Reproduce

1. In the dashboard prompt editor, type `/` at the start of a line.
2. Both `customSource` and `pathSource` in
   `src/ui/webview-react/utils/promptCompletion/createPromptCompletionClient.ts`
   (see the comment near line 101: they "can be in flight together") send
   `REQUEST_COMPLETIONS`.
3. The second request aborts the first; the first never gets a reply.

## Root Cause

65ab2aef7 added one `AbortController` per client in `WebviewMessageRouter.route()`
(`completionAbortControllers`, around lines 450-457), keyed by `clientId` only. A
new request from either source aborts whatever completion request that client has
in flight, including the other source's. The aborted handler in
`PromptEditorSupportService` returns on `!isCurrent()` without replying, so the
client-side promise for that source hangs until its own timeout (if any).

## Suggested Fix

- Key the controller by client **and** completion source, so only a newer request
  from the same source supersedes. Derive the source from the message (e.g.
  `trigger === COMPLETION_TRIGGERS.PATH` vs custom), or add an explicit additive
  field to the request payload sent by `createPromptCompletionClient`.
- When a request is aborted, still send an empty final reply for its request id, so
  no client promise is left pending.
- Add a router test where a path request and a custom request are in flight
  together and both receive replies; keep the existing supersede test.
