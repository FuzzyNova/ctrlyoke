# Hosted reconnect during a slow run-view load keeps streaming to the dead socket

- **Found:** 2026-10-25 by bug-drain review of 156bf83e0
- **Area:** `src/ui/WebviewMessageRouter.ts`, `src/ui/RunViewPublisher.ts`
- **Severity:** medium

## Symptom

A hosted browser (e.g. a phone) reconnects while a slow `LOAD_RUN_VIEW` is in flight.
The loading overlay now clears, but live step output, buffered-output replay,
terminal session replay, `ACTIVE_TERMINAL_WORKFLOWS` and later requestless run-view
pushes keep going to the closed socket and are dropped. The view looks loaded but
stays frozen until the user opens a different view.

## Steps to Reproduce

1. Open a large run in the hosted dashboard so `LOAD_RUN_VIEW` takes seconds.
2. Drop and re-establish the connection before it finishes (same clientId).
3. The reconnected tab gets `RUN_VIEW_LOADED` but never receives further live output
   for that run.

## Root Cause

156bf83e0 lets a duplicate `LOAD_RUN_VIEW` join the in-flight load and re-sends only
captured replies that carry the `requestId` (`RUN_VIEW_LOADED`,
`ACTIVE_WORKFLOW_CHANGED`; `WebviewMessageRouter.ts` around lines 448-455).
`RunViewPublisher.deliverRunView` (around lines 467-468) is the only place that
calls `registry.getViewMessageSinks().set(clientId, send)`, and it runs with the
_original_ route's `send`, a closure over the dead socket
(`CtrlYokeHostedServer.ts` around line 2806). `bindClientToAddressedLineage` also
binds that old `send`. The terminal replay and buffered-output replay
(`RunViewPublisher.ts` around lines 540, 568-578) carry no `requestId`, so they are
never re-sent to the new connection.

The test added in 156bf83e0 checks only the snapshot reply.

## Suggested Fix

Prefer the alternative from the original doc
(`dev/bugs/implemented/run-view-load-dedupe-drops-reply-after-reconnect.md`):
include a per-connection identity in the dedupe key, so a reconnect starts its own
load and everything binds to the new connection's `send`. A connection
identity may already exist on the client context (`WebviewClientContext.ts`); if
not, add one. Keep the de-duplication for real duplicates arriving on the same
connection. Add a test that a reconnect mid-load ends with the view sink, and the
lineage binding, pointing at the new connection's `send`, and that a later live
output message reaches it.
