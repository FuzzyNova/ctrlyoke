# History Search Incremental Indexing Plan

> **Status:** Not implemented. Follow-up to
> [`../implemented/HISTORY_SEARCH_PERFORMANCE_PLAN.md`](../implemented/HISTORY_SEARCH_PERFORMANCE_PLAN.md)
> (Phases 1A/1B/2, all shipped). This plan addresses the deeper inefficiency that plan's
> Phase 2 worker isolation only *contained* rather than removed — see "Why Phase 2 alone
> isn't enough" below for the incident that prompted this.

## Goal

Make a `HistorySearchIndexService` rebuild cost proportional to **what changed**, not to
the total size of history. Today it is the latter, unconditionally, and on a large
workspace (1000+ workflows, each with dozens of steps of full AI-response text) that turns
routine, frequent triggers into large, memory-heavy full-history rescans — which is the
proximate driver behind the repeated OOM crashes this service has produced (see
`HISTORY_SEARCH_PERFORMANCE_PLAN.md`'s two incidents, and a third on 2026-08-30 that
prompted this doc).

## Current behavior (confirmed by code + a live session's logs)

`runHistorySearchRebuild` (`historySearchRebuildWorker.ts:191`) has exactly two modes:
skip entirely (index still fresh), or rescan **every** run in the workspace and rewrite the
entire `documents.jsonl` from scratch. There is no middle ground.

This is not a fundamental limitation — the information needed for a delta already exists
and is already computed on every rebuild, it's just thrown away:

- `HistorySearchIndexManifest.indexedRuns` (`historySearchRebuildWorker.ts:50`) already
  stores a per-run fingerprint (`eventCount`, `lastUpdatedAt`,
  `sourceManifestMtimeMs`, `sourceEventsMtimeMs`) keyed by resolved manifest path.
- `checkHistorySearchIndexFreshness` (`historySearchRebuildWorker.ts:122`) already walks
  every current run and compares it against that fingerprint — it knows, per run, whether
  it's new/changed/unchanged. But it calls `.find(r => !r.fresh)` (line 186) and returns on
  the *first* stale run, collapsing "1 run out of N changed" into a single fresh/not-fresh
  boolean.
- `runHistorySearchRebuild` then discards that signal and does `listRunSources()` → loop
  over **all** runs → re-read every manifest + full `events.jsonl` → rebuild every
  document → rewrite the whole `documents.jsonl` (`historySearchRebuildWorker.ts:281-338`),
  every single time, regardless of how small the actual change was.

A live session's log
(`.ctrlyoke/logs/ctrlyoke-1788107516859.log`, 2026-08-30, 1312 runs / ~678k documents)
showed **20+ full rebuilds in under 4 hours**, almost all triggered by a single workflow
completing a single step (`enqueueWorkspaceRefresh`, invoked by every live
`OutputHistoryManager`). Each pass took 16-19s and pushed the worker's heap through a full
scan of the entire history. The session ended when a rebuild starting from an
already-elevated ~3GB RSS baseline (accumulated across those repeated full passes) died
mid-scan — the extension host restarted 9 seconds later with no crash dump captured, but
the same "log stops dead mid-line, fresh activation follows" signature as the confirmed
OOM in `HISTORY_SEARCH_PERFORMANCE_PLAN.md`'s "2026-08-27 Incident #2."

### A related, smaller inefficiency

`TimelineRecorder.readEvents` (`TimelineRecorder.ts:114`) reads a run's entire
`events.jsonl` into memory as one string and parses every line into a full JS object,
*before* `HistoryCandidateExtractor.toCandidate` (`HistoryCandidateExtractor.ts:301`)
truncates each field to `MAX_INDEXED_TEXT_LENGTH` (2000 chars). For workflows whose steps
are full AI-response text, that means fully materializing a large raw file per run just to
keep a few KB of truncated candidates from it. Not a leak (discarded per-run, not
accumulated across runs — `rebuild()`'s loop processes one run at a time), but it's
avoidable allocation churn on every one of the (currently) 1000+ sequential iterations a
full rebuild performs — the same "tight loop, no idle time for GC" shape
`HISTORY_SEARCH_PERFORMANCE_PLAN.md`'s Incident #2 analysis already diagnosed. This is
worth fixing but is secondary to the frequency problem above: once rebuilds are
delta-sized, this cost is paid only for the runs that actually changed, which is the
dominant win either way.

## Why Phase 2 (worker isolation) alone isn't enough

`HISTORY_SEARCH_PERFORMANCE_PLAN.md`'s Phase 2 moved the rebuild scan into a
`worker_threads` Worker so a runaway allocation "can't blow the main extension-host heap."
That's true for the main thread's heap, but a `worker_threads` Worker still runs **inside
the same OS process** as the main thread — it is not the process isolation `child_process`
would give. `HistorySearchIndexService.ts`'s `new Worker(...)` call was not configured with
`resourceLimits`, so a worker hitting V8's default heap ceiling triggered V8's own fatal
OOM handler, which aborts the whole process, not just the worker isolate — the exact
`electron.v8-oom.is_heap_oom` signature from the crash forensics.

A companion fix (shipped alongside this plan) adds `resourceLimits.maxOldGenerationSizeMb`
to that `Worker` construction, so a worker hitting its cap now fails just that rebuild via
a catchable `'error'` event instead of crashing the host. That fix is necessary but not
sufficient on its own: it contains the failure, but the underlying full-history rescan
still runs at full volume on every trigger and still drives the same baseline-creep
pattern documented in Incident #2 — it will just fail more gracefully instead of not
failing at all. This plan is the fix for the volume itself.

## Proposed design

### 1. Make the freshness check return a diff, not a boolean

Change `checkHistorySearchIndexFreshness` (or add a sibling function used by the rebuild
path) to collect the *full* set of new/changed/removed runs relative to
`manifest.indexedRuns`, instead of short-circuiting on the first stale entry via `.find()`.
The per-run comparison logic already exists (lines 148-184) — this is a matter of
collecting results instead of discarding them after the first miss.

### 2. Shard `documents.jsonl` by run

Replace the single monolithic `documents.jsonl` with one small per-run file, e.g.
`runs/<hash-of-resolved-manifest-path>.jsonl`, alongside the existing manifest. This
aligns storage granularity with the granularity `indexedRuns` already tracks and is what
makes an incremental write possible without rewriting unrelated data:

- A **changed** run: regenerate just its shard (same per-run document-building logic as
  today, scoped to one run).
- A **new** run: write a new shard.
- A **removed** run: delete its shard and drop its `indexedRuns` entry.
- **Unchanged** runs: touched not at all — no read, no re-parse, no rewrite.

### 3. Keep the full-rebuild path as a fallback, not the default

Full rescan-and-rewrite remains correct and necessary for: schema version bump, workspace
hash mismatch, a missing/corrupted index, first build for a workspace, or (as a safety
valve) a diff large enough that a full rebuild is actually cheaper than N individual shard
writes. Everything else routes through the incremental path. This keeps the existing,
already-shipped full-rebuild code (locking, atomic swap, worker isolation, the
`resourceLimits` cap) as the fallback rather than requiring a parallel implementation.

### 4. Search-time loading concatenates shards

`loadIfPossible`/`readDocumentsJsonl` (`HistorySearchIndexService.ts:216`, `:425`) need to
read all shard files instead of one file — conceptually a `readdir` over the shard
directory plus one stream-read per shard, concatenated into the same in-memory `documents`
array used today. This does not change the search-time memory profile (a retained search
still holds the full document set resident, same as today) — it only changes how that set
is assembled from disk. Not a target of this plan; flagged here only so it isn't missed as
a required companion change.

## Expected effect

The common case in the observed session — one workflow completing one step, i.e. 1 run
changed out of 1312+ — goes from "re-read and re-parse ~1312 manifests/events files,
rebuild ~678k documents, rewrite the whole index, 16-19s" to "re-read and re-parse 1 run,
rebuild a few dozen documents, write 1 shard, milliseconds." That removes the repeated
full-heap-churn pattern driving the RSS baseline creep seen in both this workspace's
OOM incidents, rather than just capping its blast radius (which is what the
`resourceLimits` fix alone achieves).

## Open questions / decisions for implementation

- Exact shard file naming and the threshold at which "diff is large enough to prefer a
  full rebuild" kicks in (e.g. percentage of runs changed) — needs a number, not just a
  qualitative rule.
- Whether shard cleanup for removed runs needs the same locked-swap-plus-cleanup dance the
  full rebuild uses (`swapIndexFiles`/`cleanupRebuildDirs`), or whether per-shard
  create/delete can be simpler given each shard is independent (no cross-shard atomicity
  requirement the way the single-file swap had).
- Whether to also address the `TimelineRecorder.readEvents` full-materialization cost
  noted above as part of this work, or track it separately — it compounds with this plan
  (delta rebuilds still pay it, just for far fewer runs) but is an independent change to a
  shared reader used outside this service.

## Non-goals

- No change to the `resourceLimits` worker-isolation safety net — this plan complements it,
  it doesn't replace it. The full-rebuild fallback path still needs that containment.
- No multi-worker fan-out for large rebuilds. The bottleneck this plan targets is rebuild
  *frequency at full volume*, not scan throughput — once rebuilds are delta-sized, the
  rare remaining full-rebuild case is small enough in practice that added worker-pool
  complexity isn't justified by the evidence gathered so far.
