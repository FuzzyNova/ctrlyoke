# History search rebuild lock wait is a fixed 60 s, but a full rebuild takes time proportional to run count

- **Found:** 2026-10-24 by timeout-budget bug sweep workflow (core-orchestration)
- **Area:** `src/core/orchestration/historySearchRebuildWorker.ts`
- **Resolution:** fixed in this commit

## Symptom

Sometimes two processes for the same project need a history search rebuild at the same moment: the VS Code extension host, the CLI (`ctrlyoke history search`), the MCP server, or a second VS Code window. One process takes the index manifest lock and starts a full rebuild. The other waits for that lock, but only for a fixed 60 s. A full rebuild takes time proportional to the number of runs in history. Session logs show about 10.7 ms per run (`400/1312 runs, elapsedMs=4286`; full passes of 1312 runs took 16–19 s). Above roughly 5,000 runs, or sooner on a slow disk or under antivirus scanning, the waiter always gets `FileLockTimeoutError`, even though the holder is alive, heartbeating, and close to finishing.

The waiting search then logs `lock still contended after its extended timeout` and falls back to `searchLegacy`. That is a capped disk scan that ignores `request.deep` and reports `indexState: FALLBACK`. So the user waits a full minute and then gets degraded results, when the fresh index was about to be ready. This user's real project already has about 1,878 runs (about 20–25 s per full rebuild), so heavy users will reach the limit as their history grows.

## Steps to Reproduce

1. Use a project with a large run history (about 5,000 or more runs), or slow the disk down (AV scanning, a network-synced home directory) so a full rebuild takes more than 60 s.
2. Force a full rebuild: delete the search index directory, or upgrade to a build with a new `INDEX_SCHEMA_VERSION`.
3. Open the project in VS Code so the extension starts the rebuild and holds the lock.
4. While it runs, run `ctrlyoke history search <query>` from a terminal on the same project.
5. The CLI blocks for 60 s, then returns fallback results (`indexState: FALLBACK`, deep matches missing) while the extension's rebuild finishes a few seconds later.

## Root Cause

- `src/core/orchestration/historySearchRebuildWorker.ts:54` sets `REBUILD_LOCK_TIMEOUT_MS = 60_000`. It is used at lines 339-552: `withFileLock(lockTargetPath, async () => { ...freshness check + full/incremental rebuild... }, { timeoutMs: REBUILD_LOCK_TIMEOUT_MS })`.
- In `src/utils/FileLockUtils.ts`, `withFileLock` treats `timeoutMs` as a deadline for acquiring the lock. The holder refreshes the lock's mtime every `staleMs / 3` (the `setInterval` heartbeat after `acquireLock`), so a live holder is never reclaimed as stale. The waiter can only run out its fixed 60 s, however much progress the holder is making.
- `HistorySearchIndexService.ensureReady` (`src/core/orchestration/HistorySearchIndexService.ts:984-1018`) waits synchronously for that rebuild before searching when the index is missing or stale.
- `HistorySearchService.ts:119-174` catches the `FileLockTimeoutError` and returns the `searchLegacy` scan, capped to `offset + limit` and non-deep, marked `FALLBACK`.
- Inside the lock, the worker re-checks freshness first (the `skipped` path that `HistorySearchIndexService.rebuild` handles at lines 1097-1108). So if the waiter had kept waiting, it would have found the holder's fresh index and skipped its own rebuild.

## Suggested Fix

A fixed acquisition deadline is the wrong design for waiting on a holder that is alive and making progress. Possible fixes:

- Wait for as long as the holder is demonstrably alive: keep waiting while the lock file's heartbeat is fresh (the stale check `acquireLock` already does), and give up only when the holder is stale. An overall ceiling, if any, should scale with run count rather than being a constant.
- Better still, let the holder publish progress (for example `processed/total` beside the lock) so a waiting process can report `indexState: BUILDING` with progress to its caller, as the in-process `onProgress` path already does, instead of blocking with no feedback.
- Alternatively, don't block search on a rebuild another process is running. When the lock is held, answer from the existing on-disk index if there is one (`allowRebuild = false` behavior, `BUILDING` state), or from the fallback right away with a clear "index building in another process" state, and retry the indexed path on the next page request. Paging already supports this, much like the resumable session in `src/server/WorkspaceSearchSession.ts`.
