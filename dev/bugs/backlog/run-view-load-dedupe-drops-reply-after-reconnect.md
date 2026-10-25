# LOAD_RUN_VIEW dedupe sends the answer to a dead socket after a hosted reconnect

- **Found:** 2026-10-24 by bug-drain review of 45a330a96
- **Area:** `src/ui/WebviewMessageRouter.ts`, `src/server/CtrlYokeHostedServer.ts`, `src/ui/webview-react/hooks/useRunViewLoadWatchdog.ts`
- **Severity:** high

## Symptom

In the hosted dashboard (e.g. on a phone), if the socket drops and reconnects
while a slow run-view load is in flight, the run-switch overlay stays up forever
and later requestless pushes are suppressed.

## Steps to Reproduce

1. Open a large run from the hosted dashboard; the load takes ~40 s.
2. At ~10 s the socket drops; it reconnects at ~20 s.
3. On `CLIENT_ID_ASSIGNED` the client reissues the same request
   (`terminalMessageHandlers.ts`, around line 117).
4. The router finds the in-flight entry for the same key, awaits it and returns
   without queueing anything.
5. The original route's reply goes through the old socket's `postMessage`, which
   drops it because that socket is closed.
6. The transport is connected, so the watchdog never gives up, and
   `pendingRunViewRequestId` stays set.

## Root Cause

45a330a96 dedupes `LOAD_RUN_VIEW` in `WebviewMessageRouter.route()` (around lines
430-441) by `clientTag + requestId`. `resolveClientTag` gives a reconnecting browser
the same tag, but the original route captured the old connection's `postMessage`.
The joined duplicate never re-sends the result through its own `postMessage`.

## Suggested Fix

Let the duplicate re-deliver: store the in-flight route's result (or have the
handler return the reply payload) and, when a duplicate joins, post the finished
answer through the duplicate's own `options.postMessage` if it differs from the
original's. Alternatively, include a per-connection identity in the key so a
reconnect starts a fresh load. Add a router test: a load in flight, a duplicate
with a different `postMessage`, and assert the duplicate's `postMessage` receives the answer.
