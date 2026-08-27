# History Search Performance & Isolation Plan

**Status:** Proposed
**Priority:** P2

## Background

`HistorySearchIndexService` has OOM'd the extension host before (see
`.github/instructions/orchestration.instructions.md`). A 2026-08-27 incident
investigation confirmed a concrete instance of this: a workspace with 1250+
runs / 642k documents saw the extension-host process crash on a V8
`CALL_AND_RETRY_LAST` heap OOM (`extensionHost` process type, confirmed via
Crashpad dump) while a search-triggered index rebuild was contending with a
live workflow's background refresh for the on-disk index lock.

That investigation already shipped three fixes (see git history around
2026-08-27):

- `FileLockUtils.withFileLock` gained an optional `{ timeoutMs }`, and
  `HistorySearchIndexService.rebuild()` now passes a 60s
  `REBUILD_LOCK_TIMEOUT_MS` instead of the library default 5s — a full
  rebuild routinely takes ~20s on a large history, so the 5s default made any
  overlap between two rebuilds time out the loser and, on the search path,
  fall through to `HistorySearchService`'s unindexed, unbounded disk scan.
- `HistorySearchService`'s disk-scan fallback now caps candidate text at
  `MAX_INDEXED_TEXT_LENGTH` (exported from `HistorySearchIndexService`),
  matching the indexed path. It previously built full, uncapped documents —
  reproducing the exact heap-growth pattern that cap exists to avoid — and it
  runs precisely when the system is already under memory pressure.
- `src/utils/MemoryDiagnostics.ts#logMemoryUsage()` now logs
  `process.memoryUsage()` around `rebuild()` start/end and the disk-scan
  fallback, so a recurrence is diagnosable from the log instead of requiring
  another crash-dump investigation.

Those fixes remove the immediate crash trigger. Two structural inefficiencies
remain, both called out during that investigation and explicitly requested
here as backlog work, plus a heavier isolation option to evaluate afterward.

## Problem 1: An instance that waits out someone else's rebuild reruns its own

Every live workflow's `OutputHistoryManager` owns a private
`HistorySearchIndexService` instance (`OutputHistoryManager.ts:142`), and the
search UI (`CtrlYokeWebviewProvider.ts:114`) owns a separate one again.
`rebuild()`'s in-flight coalescing (`rebuildPromise`/`rebuildQueued`) only
dedupes calls *within one instance* — it does nothing for two instances
racing the same on-disk index. They now serialize correctly through the
60s-timeout file lock instead of one of them failing outright, but the
instance that waited still performs its own full rebuild after acquiring the
lock, even though the instance that just released it wrote a fresh index
seconds ago. On a large history that's a second ~20s, full-heap-churning
rebuild pass for no reason.

### Phase 1A — freshness recheck inside the lock (do this first)

Once `rebuild()` acquires the lock, re-run the existing `isManifestFresh()`
check against what's now on disk *before* calling `listRunSources()` and
starting the scan. If a sibling rebuild just finished and nothing changed in
the interim (the common case — two workflows completing near-simultaneously
both want to index the same recent batch), skip straight to
`loadIfPossible()`/return instead of rescanning the whole history.

This is a small, contained change to the start of `rebuild()`'s locked
section — no ownership or lifecycle redesign, no new failure modes (worst
case it does exactly what it does today: a full rebuild). Ship it
independently of Problem 2 and Phase 1B below.

### Phase 1B — consolidate to a shared instance (evaluate after 1A ships)

The deeper fix is giving `OutputHistoryManager` (all of them) and the search
UI the same `HistorySearchIndexService` instance instead of one each. That
gets the *existing* `rebuildPromise`/`rebuildQueued` coalescing to work
globally — not just for the "waited on the lock, recheck freshness" case
above, but for any two refreshes that would otherwise overlap at all — and
collapses what can currently be several duplicate warm document caches (the
search UI's retained copy, plus whatever a live workflow's write-only
refresh briefly builds before discarding) into the one retained copy the
original design already intended (`rebuild(..., { retainDocuments })`'s
doc comment: "the single reader keeps one warm copy").

This is a larger change than 1A: it needs a lifecycle owner (most likely
`WorkflowOrchestrator`, which already sits above both `OutputHistoryManager`
and the webview provider), and it touches a subsystem this repo's own
instructions flag as fragile ("has OOM'd the extension host before"). Gate
this on what the memory logging from the prior fix actually shows — if 1A
already eliminates most of the duplicate-rebuild cost in practice, 1B may not
be worth the risk. Revisit once there's a few weeks of `[MemoryDiagnostics]
HistorySearchIndexService rebuild` log data from real usage.

If pursued, the shared instance should be workspace-scoped (keyed by
`workspaceFolderPath`), not a single process-wide singleton — ctrlyoke
supports multiple workspace folders and this must not cross-contaminate
their indexes.

## Problem 2: No heap isolation for the rebuild scan itself

Even with Problems 1A/1B fixed, a full rebuild's scan loop
(`listRunSources` → per-run manifest/events read → candidate extraction →
JSONL stream-out) still runs on the extension host's own V8 heap. A
sufficiently large history, or a single unusually large run, can still push
that heap toward the same OOM this whole investigation started from — the
lock/dedup fixes reduce *how often* a big rebuild runs, not *how much heap*
one rebuild can consume while it runs.

### Proposal: move the rebuild scan into a `worker_threads` worker

Node's `worker_threads` gives a worker its own V8 isolate/heap. A runaway
allocation there can't blow the main extension-host heap, and if the worker
does OOM, only that worker dies — the extension host, and every other live
workflow, is unaffected. This was evaluated against a full separate OS-process
daemon and rejected in favor of a worker thread; see **Rejected: separate
process/daemon** below for why.

Design sketch:

- New worker entry module, e.g.
  `src/core/orchestration/historySearchRebuildWorker.ts`, performing exactly
  the locked section of today's `rebuild()`: list run sources, read each
  run's manifest/events, extract capped candidates, stream them to
  `documents.jsonl`, write the manifest, swap files into place.
- **The worker never sends documents back over the message channel.** It
  only posts small status messages (progress ticks matching today's
  `IndexRebuildProgressCallback` shape, and a final success/error result).
  A caller that needs the built documents in memory (the "retained" reader
  path) reloads them afterward via the existing `loadIfPossible()` /
  `readDocumentsJsonl()` streaming read from the now-fresh on-disk JSONL —
  the same code path already used for a cold load. This avoids structured-
  cloning a 642k-document array across the thread boundary, which would
  just relocate the heap-growth problem rather than solve it.
- The on-disk file lock (`withFileLock`) works identically from a worker —
  it's filesystem-based, not an in-process mutex — so none of the
  Problem-1 lock/coalescing logic needs to change to accommodate this; the
  worker acquires the same lock the main thread does today.
- `esbuild.js` needs a second bundle entry point for the worker script,
  the same way `out/cli.js` is already a separate bundle from the main
  extension-host bundle. `HistorySearchIndexService.rebuild()` spawns the
  worker, passes `workspaceFolderPath` + rebuild options, and awaits its
  result via `MessageChannel`/`Worker.on("message"/"error"/"exit")`.
- Scope this to `rebuild()`'s scan loop only. `search()`'s in-memory
  filter/sort over already-loaded documents is fast and doesn't need
  isolation; leave it on the main thread.

## Non-goals

- **No separate OS-process daemon.** Rejected during the incident
  investigation: the actual crash forensics showed the harness CLI process
  itself (spawned via `node-pty`) already survives an extension-host crash
  and runs to completion independently — what OOM'd was ctrlyoke's own
  in-heap bookkeeping (duplicate rebuilds, unbounded fallback text), not
  fundamentally "memory-intensive work" that needs a whole separate process.
  A real daemon would also cost far more than this plan's problems justify:
  a second bundled executable, an IPC protocol to design and version,
  process lifecycle/crash-restart/orphan-cleanup handling (this repo's own
  `dev/reference/DEVELOPING_CTRLYOKE_WITH_CTRLYOKE.md` notes graceful-close
  is "only empirically verified on Windows so far" for a much simpler
  dev-only case), multi-window/workspace singleton coordination (the same
  lock-contention shape as Problem 1, just moved to a socket), and version
  skew against the auto-updating extension.
- No worker-thread isolation for other subsystems (PTY output buffering,
  general output-history persistence) — this plan is scoped to the one place
  with concrete OOM evidence. A similar case would need to be made from data
  before extending the pattern elsewhere.
- No change to `HistorySearchService`'s disk-scan fallback beyond what
  already shipped (text cap). That path is a safety net for when the index
  is unavailable, not a hot path to optimize further here.

## Sequencing

1. **Phase 1A** (small, low-risk): freshness recheck inside the rebuild
   lock. Ship independently and first.
2. **Phase 2** (worker-thread isolation for the rebuild scan): the highest-
   value remaining item for the original OOM concern, and independent of
   Phase 1B — implement once Phase 1A is in and stable.
3. **Phase 1B** (shared/workspace-scoped index-service instance): gated on
   memory-log data showing Phase 1A + Phase 2 haven't already made duplicate
   rebuilds a non-issue in practice. Revisit, don't build speculatively.

## Acceptance criteria

- Two `HistorySearchIndexService` instances (e.g. two workflows completing
  near-simultaneously) no longer both run a full rebuild pass when the
  second one's data would already be fresh after the first's completes.
- A full index rebuild's scan/extraction work runs off the extension host's
  main heap, and a worker-side OOM does not crash or degrade the extension
  host or any other live workflow.
- `search()`'s synchronous rebuild-before-search path still reports progress
  to the UI (existing `SEARCH_INDEX_REBUILD_PROGRESS` messages) when the
  work has moved to a worker.
- No regression to existing `HistorySearchIndexService`/`HistorySearchService`
  unit test coverage; new coverage for the freshness-recheck skip path and
  for worker success/failure/progress relay.
- If Phase 1B is undertaken: a workspace's index-service instance is scoped
  per `workspaceFolderPath`, never a single cross-workspace singleton.
