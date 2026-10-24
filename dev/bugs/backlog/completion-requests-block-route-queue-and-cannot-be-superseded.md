# Completion requests hold the shared routeQueue, and a stale one can't be superseded, so a cold `#` query freezes every dashboard client for about 10 s

- **Found:** 2026-10-24 by timeout-budget bug sweep workflow (ui)
- **Area:** `src/ui/PromptEditorSupportService.ts`
- **Severity:** medium

## Symptom

The first `#` completion in a session (and others whenever the symbol provider is slow) holds the dashboard's one serialized `routeQueue` for 10-12 s on this repo. While it runs, every other message from every client (panel and hosted tabs) waits. That includes forwarded logs, clicks, run loads and further completion keystrokes. Session logs:

```
17:49:24.595 Completion response: position=86, partial=true 1 items
17:49:35.117 Completion response: position=86, partial=false 501 items
17:49:35.125 [RouteTiming] slow route type=requestCompletions client=panel waitMs=0 runMs=10530
17:49:35.125 [RouteTiming] slow route type=logMessage client=panel waitMs=10069 runMs=0
```

Other sessions show `runMs=11833`, `11571`, `11420` and `9972`. A follow-up keystroke shows as `waitMs=3069 runMs=4`: it was queued behind the slow one, then answered at once.

Correction to the original candidate: the logs show one slow query per session, not one per keystroke. `VsCodeSymbolIndex` caches its language-server warm-up, and later queries come back fast. So there is no 80-second freeze from 8 keystrokes. The real problem is that one slow query blocks all clients, and the design cannot pre-empt it.

## Steps to Reproduce

1. Open a large TypeScript workspace (this repo) in a fresh VS Code window. Open the dashboard and do not open any TS file in an editor.
2. Type `#Work` in the prompt editor.
3. While the dropdown waits for its full list, click anything else in the dashboard, or watch a hosted tab. Nothing responds for about 10 s, and the session log shows `[RouteTiming] ... waitMs≈10000` for the messages that were queued behind it.

The same thing happens with `@` while the workspace file index is `BUILDING`. The handler loops for the whole index build, holding the queue the entire time.

## Root Cause

- `src/ui/WebviewMessageRouter.ts:191-198`: `OFF_QUEUE_MESSAGE_TYPES` does not include `REQUEST_COMPLETIONS`, so it is chained onto `this.routeQueue` at `:466`.
- `src/ui/PromptEditorSupportService.ts:317-334`: the `#` branch awaits `completionCore.getHashCompletions()` with no `AbortSignal`. It ends in `VsCodeSymbolIndex.workspaceSymbols()` (`src/platform/VsCodeSymbolIndex.ts:59-72`), which runs the language-family warm-up and then `vscode.executeWorkspaceSymbolProvider`.
- `src/ui/PromptEditorSupportService.ts:310`: the supersession `this.activeFileCompletionRequests.get(ctx.clientId)?.abort()` only runs once the *newer* request reaches the head of `routeQueue`. The stale handler is what holds the head, so the abort never pre-empts anything. It only fires after the stale work has finished.
- `src/ui/PromptEditorSupportService.ts:345-397`: while `getFileIndexStatus()` is `BUILDING`, the `@` branch re-queries every 500 ms (`:383`) inside the same handler, so the queue stays held for the entire index build. The newer keystroke that should abort it is stuck behind it.
- On the client, `promptCompletionResult.ts:139-140` re-queries on every keystroke, so a backlog of stale requests builds up behind the slow one. Each still runs in full on the host after the client has thrown its answer away.

`SEARCH_HISTORY` already has the right pattern: `beginHistorySearch()` registers the abort synchronously in `route()`, *before* the message is queued (`WebviewMessageRouter.ts:445-457`). A precedent in this same class was `dev/bugs/implemented/secret-registry-request-blocks-route-queue-with-powershell-spawns.md`, which was fixed by moving that request off-queue.

## Suggested Fix

Completions are read-only. They mutate no state that other handlers depend on, so they qualify for `OFF_QUEUE_MESSAGE_TYPES` (the reply is already epoch-guarded by `route()`).

1. Add `REQUEST_COMPLETIONS` to `OFF_QUEUE_MESSAGE_TYPES`.
2. Register the per-client `AbortController` synchronously when the message arrives, as `beginHistorySearch` does, so a newer keystroke aborts the older request straight away. This applies to every trigger, not only `@`.
3. Thread the signal through `getHashCompletions` → `getSymbolCompletions` → `SymbolIndex.workspaceSymbols` (the interface already accepts `signal`; `VsCodeSymbolIndex` ignores it). The stale result is then dropped rather than emitted, and the warm-up is awaited once.
4. Keep the `@` index-build polling. Off-queue and cancellable, it then streams progress the way it was meant to and never blocks other clients.

Don't add a timeout. The work is legitimately slow on a cold language server, and the fix is to stop it blocking other work and to make it cancellable.
