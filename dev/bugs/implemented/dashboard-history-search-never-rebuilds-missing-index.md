# Dashboard history search never rebuilds a missing or stale index

- **Found:** 2026-10-25 by bug-drain review of 55a7e00b2
- **Area:** `src/ui/WebviewMessageRouter.ts`, `src/core/orchestration/HistorySearchIndexService.ts`
- **Resolution:** fixed in this commit

## Symptom

After an upgrade that bumps `INDEX_SCHEMA_VERSION`, after the index directory is
deleted, or on any workspace whose index is stale, dashboard history search shows
"building" with no results (or stale results) indefinitely. Nothing is actually
building. It stays that way until some workflow happens to append history, which
queues a background refresh.

## Steps to Reproduce

1. Delete the history-search index directory for a workspace with run history (or
   bump `INDEX_SCHEMA_VERSION`).
2. Open the dashboard and search history.
3. The response is `indexState: building`; repeat searches never become `ready`.

## Root Cause

55a7e00b2 made the dashboard search handler in `WebviewMessageRouter.ts` (the
`SEARCH_HISTORY` route, around line 2081) always pass `{ allowRebuild: false }`.
`HistorySearchIndexService.ensureReady` (around line 1021) then returns
`HISTORY_SEARCH_INDEX_STATES.BUILDING` for _any_ missing or stale index, without
starting a rebuild. The dashboard used to be the path that ran the rebuild. The only
remaining triggers are `enqueueWorkspaceRefresh` calls on history append and trash
operations (`OutputHistoryManager.ts`, `HistoryTrashRepository.ts`); nothing runs one
at startup or on search.

The original bug (`dev/bugs/implemented/dashboard-history-search-blocks-route-queue-on-foreign-rebuild.md`)
asked to skip the wait only when _another live process_ holds the rebuild lock.

Secondary: background refreshes in the extension host also stopped passing
`waitWhileHolderAlive`/`waitForLiveLock`. While another process runs a rebuild for
more than 60 s, the refresh fails with `FileLockTimeoutError`, is only logged and is
never retried, so runs appended in that window stay unsearchable.

Also note the test "serves the existing index promptly while a foreign rebuild lock
is live" in `src/test/unit/HistorySearchIndexService.test.ts` passes without
55a7e00b2's service changes: with `allowRebuild: false` the lock is never consulted.

## Suggested Fix

- When the dashboard search finds the index missing or stale, it must not block the
  route queue, but it must ensure a rebuild is running. Decide by the lock: if a live
  foreign holder has it, answer immediately from what is on disk with `BUILDING`; if
  not, kick off (or join) this process's rebuild in the background (not awaited inside
  the route handler), answer with `BUILDING`, and let the existing
  `SEARCH_INDEX_REBUILD_PROGRESS`/partial-results machinery, or the next search,
  pick up the ready index. Check how the webview reacts to `BUILDING` (does it
  re-query when the rebuild finishes?) and make sure the user eventually sees results
  without retyping. If it doesn't re-query, emit a message on completion that makes it
  re-run the active query.
- Restore lock waiting for background refreshes (they run off the route queue), or
  retry a refresh that failed with `FileLockTimeoutError` once the holder releases.
- Tests: missing index plus dashboard search leads to a rebuild and eventually
  `READY`; a foreign live lock leads to an immediate `BUILDING` with no wait; the
  background refresh survives a foreign rebuild longer than 60 s. Each test must fail
  on the current code.
