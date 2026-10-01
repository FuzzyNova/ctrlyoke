# History search document cache loses matches after a cancelled scan and serves stale shards after an external rebuild

- **Found:** 2026-09-30 by the bug-backlog workflow final step (claude-cli), reproduced against the compiled modules
- **Area:** `src/core/orchestration/HistorySearchIndexService.ts` (`scanForMatches` `consider` closure and the `addedDedupeKeys` rollback ~700-810; `rebuild()` `result.skipped` branch ~1060)
- **Resolution:** fixed in this commit

## Symptom

1. **Cancelled scan over cached shards.** With 40 runs containing a term: warm the
   document cache with any query that scans every shard; search the term with
   `limit: 5`; request `offset: 30` and abort from the partial-results callback; search
   again with `limit: 100`. A cold cache returns 40 (the existing test). A warm cache
   returns `totalCount=39` with `countState=exact`. Real trigger: scroll a result list,
   type a different query (the router aborts the old one), go back to the first query.
2. **External rebuild.** Extension instance A searches `before-term` (the run's shard is
   cached). An `after-term` event is appended to that run. Another process (the CLI
   `history search`, e.g. an AI step running `ctrlyoke history search --this-workflow`,
   or the MCP server) searches, rebuilding the on-disk index. A then searches `after-term`
   and gets 0 results with `indexState=ready`; a fresh instance gets 1.

## Root Cause

1. After an abort, `findHistorySearchMatch` rejects immediately; `consider` rethrows it as
   `HistorySearchCancelledError`, which exits `scanForMatches` before the
   `addedDedupeKeys` rollback runs. Dedupe keys admitted for earlier groups stay in the
   snapshot cursor's shared `seen` set, so the resumed scan skips those documents. The
   cold path avoids it only because `readShardDocuments` returns `[]` on abort.
2. A's stale in-memory manifest starts the rebuild worker, which compares against the
   on-disk manifest B already refreshed and reports `skipped`. A reloads the manifest but
   never invalidates its document cache ("nothing on disk changed" is only true relative
   to disk, not to A's cache).

## Suggested Fix

1. Run the rollback in a `finally` (or catch cancellation) around the shard loop, and
   check `signal.aborted` before each `consider` in the cached and full-read loops.
   Regression test: the warm-cache version of the existing cancellation test.
2. Whenever a manifest is (re)loaded, diff the previous and new `indexedRuns` and
   invalidate shards whose entries were added, removed, or changed (mtime/`eventCount`),
   or simply clear the document cache on a `skipped` result that changed the manifest.
   Test with two service instances sharing one index directory.
