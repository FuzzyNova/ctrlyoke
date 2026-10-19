# Snapshot content requests re-scan the whole run per file and retry while still queued

- **Found:** 2026-10-19 by Claude Code (performance investigation, session-log review)
- **Area:** `src/core/orchestration/OutputHistoryManager.ts`, `src/core/WorkflowOrchestrator.ts`, `src/ui/webview-react/hooks/useWorkspaceSnapshotContent.ts`, `src/ui/webview-react/components/output/OutputRow.tsx`
- **Resolution:** fixed in this commit

## Symptom

Opening a completed run with large file-change snapshots makes the extension host's heap
balloon and its queue stall. In `.ctrlyoke/logs/ctrlyoke-1792417297943.log` (2026-10-19,
installed 0.2.0 build) the `media-plan` run view was delivered at 13:42:00. Over the next
40 s the heap went 283 MB → 635 MB → 1,015 MB → **1,692 MB**, `STARTUP_COMPLETE` sent at
13:42:03 reached the panel only at 13:42:22, and bursts of
`[MessageHandler] Unknown message type: workspaceSnapshotContent` (the replies, 638 in the
week's logs) arrived in batches. That run's `events.jsonl` is 18 MB, with snapshots of up to 63
changed files and one 6.5 MB snapshot event.

## Steps to Reproduce

1. Open a run whose steps changed many files (any run with `workspaceSnapshotCaptured` events
   listing dozens of files), with diffs expanded.
2. Watch the session log: heap growth in `[MemoryWatchdog]`, and multi-second `waitMs` in
   `[RouteTiming]` for the `requestWorkspaceSnapshotContent` routes and everything behind them.

## Root Cause

Three costs multiply:

1. **Every file re-scans the run.** `WorkflowOrchestrator.getWorkspaceSnapshotFileContent`
   (`src/core/WorkflowOrchestrator.ts:2946`) builds a new `OutputHistoryManager` whenever the
   run is not the live instance's, so the `liveSnapshots` cache is empty, and
   `getSnapshotFileContent` (`src/core/orchestration/OutputHistoryManager.ts:956`) calls
   `RunMetadataScanner.findLatestWorkspaceSnapshot`, which streams and `JSON.parse`s every line
   of `events.jsonl` (`RunMetadataScanner.ts:28`), including multi-MB CLI output events, once
   per requested file.
2. **Every file enriches every file.** It then calls `enrichWorkspaceSnapshot(snapshot)` on the
   **whole** snapshot (line 981) to return one entry.
   `WorkspaceSnapshotService.enrichSnapshotBeforeContent`
   (`src/utils/WorkspaceSnapshotService.ts:1293`) runs `discoverRepos` and one `git show` per
   modified git-HEAD file. `OutputRow` hydrates the whole snapshot for each expanded diff row
   (`hydrateSnapshot`, `OutputRow.tsx:701`), so a 63-file step costs 63 requests × 63
   `git show`s, plus 63 full timeline parses.
3. **Retries pile on while the work is queued.** 68ea497a1 (2026-10-14) made
   `WorkspaceSnapshotContentClient.request` re-send the request every 5 s, up to 4 times
   (`useWorkspaceSnapshotContent.ts:15-16,122-131`). The handler sits in the router's shared
   `routeQueue`, so once a backlog takes more than 5 s every pending file is requested again,
   which deepens the backlog. Replies that carry no content (e.g. added files) are not cached
   (lines 90–97), so remounting a row re-requests them.

## Suggested Fix

- Read the snapshot once per (run, target) and cache it in a shared, size-bounded cache that
  does not depend on the live instance. Better still, record the snapshot event's byte offset
  in `manifest.json` so the read seeks instead of scanning.
- Enrich only the requested file (`git show` for that one path), or accept a batch of paths
  in one request so a step's diffs hydrate in a single round trip.
- Make retries queue-aware. Don't re-send a request whose `requestId` the host has
  acknowledged or is still processing (an ack, or a much longer timeout, works), and dedupe
  identical in-flight requests on the host side by `(address, target, path)`.
- Cache "no content" replies as well, so remounted rows don't re-request.
