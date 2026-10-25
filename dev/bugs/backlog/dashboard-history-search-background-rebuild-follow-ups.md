# Dashboard history search queues extra rebuilds and never cancels its follow-up searches

- **Found:** 2026-10-25 by bug-drain review of fdecf81a1 and ad5da660b
- **Area:** `src/ui/WebviewMessageRouter.ts` (history search handler, `beginHistorySearch`/`releaseHistorySearch`, run-view load dedupe), `src/core/orchestration/HistorySearchIndexService.ts` (`ensureReady`, `enqueueWorkspaceRefresh`)
- **Severity:** medium

## Symptom

fdecf81a1 fixed dashboard history search never rebuilding a missing index, and the route
queue stays unblocked. But while the index builds:

1. Every BUILDING search queues an extra full rebuild pass, so a user typing during a
   build keeps the rebuild loop running (each pass spawns a worker, takes the lock, and
   stats every run in its freshness scan).
2. Superseded searches are never cancelled. Typing 15 characters on a missing index gives
   15 detached follow-up searches that all run full scans when the rebuild finishes. The
   webview drops the stale replies, so the cost is wasted CPU and I/O, not wrong output.
3. A rebuild failure is never shown; the drawer stays on "building" until the user
   searches again.

## Root Cause

1. `ensureReady` (`HistorySearchIndexService.ts` around lines 1031–1033) already calls
   `enqueueWorkspaceRefresh`, which sets `rebuildPromise`. The router's detached follow-up
   (`WebviewMessageRouter.ts` around lines 2097–2098) calls `enqueueWorkspaceRefresh`
   again, which hits the coalesce branch (around lines 955–957) and sets
   `rebuildQueued = true`, forcing another pass.
2. `releaseHistorySearch()` removes the search's abort controller from the client's set as
   soon as the route handler returns, but the detached follow-up (around lines 2101–2117)
   still uses `ctx.historySearchAbortSignal`. `beginHistorySearch` (around lines 571–575)
   and `disposeClient` (around 610–639) abort only controllers still in the set.
3. `enqueueWorkspaceRefresh` catches and logs errors (around lines 980–983), then resolves.
   The follow-up searches again with `allowRebuild: false` and no `rebuildInBackground`,
   which emits BUILDING again and starts nothing.

### Same file, from ad5da660b (low): dead run-view dedupe code

Hosted connections now pass one stable `send` per socket and the panel uses a stable
`routeMessagePost`, so equal connection IDs imply the same `postMessage`. The
`duplicatePostMessage !== existing.originalPostMessage` re-delivery branch
(`WebviewMessageRouter.ts` around lines 451–457), the `originalPostMessage`/`replies`
fields on `LoadRunViewRouteEntry`, and `captureReply`'s reply buffering (around 469–485)
can no longer do anything. Remove them, keeping the dedupe of real duplicates on one
connection and the reconnect test from ad5da660b passing.

## Suggested Fix

1. Add a non-queuing join accessor on the index service (for example
   `waitForActiveRefresh(): Promise<RefreshOutcome>` returning the in-flight
   `rebuildPromise` or a resolved "idle" outcome) and have the router's follow-up await
   that instead of `enqueueWorkspaceRefresh`.
2. Keep the search's controller registered until the detached follow-up settles (release
   it in the follow-up's `finally`), so a newer search or client disposal aborts it.
   Check the signal before running the follow-up search.
3. Let the refresh report failure to joiners (resolve to a status, or reject joiners while
   the background caller still only logs) and have the router emit the error/fallback
   state the drawer already supports instead of BUILDING.
4. Remove the dead run-view re-delivery code above.
5. Tests: one dashboard search on a missing index runs exactly one rebuild pass; a second
   search during the build does not queue another; a superseded search's follow-up never
   runs its search; disposing the client aborts it; a failing rebuild produces the error
   state. Also consider shortening the 61 s lock-wait test added in fdecf81a1 with an
   injectable timeout so it doesn't take a minute of the unit suite.
