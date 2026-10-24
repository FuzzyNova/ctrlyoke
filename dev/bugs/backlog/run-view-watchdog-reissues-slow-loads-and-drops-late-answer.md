# Run-view watchdog re-sends LOAD_RUN_VIEW every 15 s even in the VS Code panel, then rolls back after about 75 s and drops the answer that was still coming

- **Found:** 2026-10-24 by timeout-budget bug sweep workflow (ui)
- **Area:** `src/ui/webview-react/hooks/useRunViewLoadWatchdog.ts`
- **Severity:** medium

## Symptom

A slow but healthy run load is treated as a lost message. Every 15 s the dashboard re-posts the same `LOAD_RUN_VIEW`. If no `RUN_VIEW_LOADED` arrives within about 75 s (the 15 s interval × (4 reissues + 1)), it rolls the view back and reports "Couldn't load that workflow — check the connection and try again." This happens in the local VS Code panel too, where `postMessage` never drops anything. When the real answer finally arrives, it is thrown away.

From `.ctrlyoke/logs/ctrlyoke-1792699502034.log` (local panel):

```
21:14:09.007 [RouteTiming] slow route type=loadRunView client=panel waitMs=0 runMs=46708
21:14:09.009 [panel] [runViewWatchdog] RUN_VIEW_LOADED for request run-view-1792703602210-3 has not arrived — reissue 1/4
21:14:09.276 [RouteTiming] slow route type=loadRunView client=panel waitMs=21913 runMs=266
21:14:09.277 [panel] [runViewWatchdog] ... reissue 2/4
21:14:09.333 [RouteTiming] slow route type=loadRunView client=panel waitMs=7529 runMs=56
21:14:09.334 [panel] [runViewWatchdog] ... reissue 3/4
21:14:09.359 [RouteTiming] slow route type=loadRunView client=panel waitMs=1167 runMs=24
```

So a 46.7 s load produced three duplicate loads, queued behind it in the panel, and used 3 of the 4 reissues. Any load (or queue wait plus load) that goes past the fifth tick (about 75 s) rolls back as a "connection" failure, even though the extension host is still working on it. Run history here has 2,252 runs with `events.jsonl` files up to 98 MB. Other loads are 10-14 s, and the queue in front of them can hold `ready` (19 s) or a cold completion (10 s, see `completion-requests-block-route-queue-and-cannot-be-superseded.md`).

## Steps to Reproduce

1. Have a run with a very large `events.jsonl` (tens of MB), or make the machine slow (e.g. antivirus scanning the run directory).
2. In the VS Code panel, select that run from history.
3. Watch the session log: a `[runViewWatchdog] ... reissue n/4` line every 15 s, and extra `type=loadRunView` routes queued behind the first.
4. If the load passes about 75 s, the overlay rolls back, the connection error toast appears, and the late `RUN_VIEW_LOADED` is ignored.

## Root Cause

- `src/ui/webview-react/hooks/useRunViewLoadWatchdog.ts:12-14`: a fixed `RUN_VIEW_RETRY_INTERVAL_MS = 15000` and `RUN_VIEW_MAX_RETRIES = 4`, set as wall-clock patience with no link to how much work the load is doing.
- `:55-92`: the interval runs for every transport. The doc comment (`:27-35`) says it exists for the hosted `standalone-shim.js` dropping messages while the socket is down, but nothing limits it to that case. Each tick posts another `LOAD_RUN_VIEW` with the same `requestId`.
- `src/ui/WebviewMessageRouter.ts:1787-1807`: the backend has no dedupe by `requestId`. Each reissue queues another `loadRunViewForClient` on `routeQueue`.
- `:61-77`: after the 4th reissue, `rollbackRunViewLoad()` clears `pendingRunViewRequestId` and shows a connection error.
- `src/ui/webview-react/hooks/useMessageHandler.ts:2645-2651`: once `pendingRunViewRequestId === null`, a `RUN_VIEW_LOADED` that carries a `requestId` returns early, so the finished load is dropped.

## Suggested Fix

The fixed wall-clock budget is the wrong design. The thing to detect is a dropped message, not a slow load.

- Reissue only when the transport actually lost the message. Arm the reissue on hosted reconnect, or when the shim reports it dropped an outbound message, not on a timer in the VS Code panel. Without a reconnect there is nothing to heal.
- Have the host acknowledge `LOAD_RUN_VIEW` when it starts the load, and send progress for long loads (much as `WorkspaceSearchSession` reports a resumable session rather than a deadline). The client keeps waiting while acks or progress keep arriving, and rolls back only when the transport is dead.
- Dedupe by `requestId` on the host. A reissue of a load already queued or in flight should join it, not queue another full load.
- After a client-side give-up, still apply a late `RUN_VIEW_LOADED` whose `requestId` matches the one just retired (if the user has not navigated elsewhere since), rather than dropping it.
