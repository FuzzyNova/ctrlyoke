# History Search Responsive Query Plan

**Status:** Backlog — not started
**Priority:** P0 — this is a live regression in daily use, not a future risk.
**Predecessor:** `dev/implemented/HISTORY_SEARCH_INDEX_RESIDENCY_PLAN.md` removed
the ~2.16 GB resident index by streaming every shard per query. It fixed the
memory exposure and regressed query latency by ~17x. This plan buys the
latency back without reopening the residency problem.

## The problem in one sentence

Every query streams and scans the **entire** index before returning anything,
so a search costs ~20 s regardless of how few documents it matches, and a
session of 20 searches spends about **seven minutes** waiting.

## Measured on the real workspace (2026-09-19)

From `.ctrlyoke/logs/ctrlyoke-1789787194624.log` — real searches, not a
benchmark. Index at the time: 1,560 runs, 1,672,357 documents, 1.6 GB of
shards, schema 4.1.0 (the raw-line-lowercase prefilter; see "Which build these
numbers are from" below).

| Query                     | Matches | Ready ms | Match ms |    Total ms |
| ------------------------- | ------: | -------: | -------: | ----------: |
| first search              |   2,623 |   91,531 |   19,012 | **110,543** |
| `codemirroredito`         |   2,623 |      571 |   19,646 |      20,217 |
| `okay`                    |     284 |      585 |   20,958 |      21,543 |
| `okay` (immediate repeat) |     284 |      530 |   20,412 |      20,942 |
| `codemirroreditor`        |   2,623 |      529 |   20,424 |      20,953 |
| `co`                      | 260,109 |      577 |   40,940 |      41,517 |
| `but why`                 |      21 |      529 |   20,299 |      20,828 |

Against the same index, the pre-streaming resident design measured a one-time
load of 11,513–11,800 ms and then **1,216–1,220 ms per query**.

**Session arithmetic, at the reported ~20 searches per session:**

| Design            |                      20 searches |
| ----------------- | -------------------------------: |
| Resident (before) | 11.5 s load + 24.4 s = **~36 s** |
| Streamed (now)    |                       **~416 s** |

## What the numbers actually say

1. **Scan cost is independent of selectivity.** 21 matches costs 20,299 ms;
   2,623 matches costs 20,424 ms. The floor is the full 1.67M-document pass,
   not the work of collecting hits. Only the degenerate `co` (260,109 matches)
   doubles it, because projecting and sorting a quarter-million results is
   finally comparable to the scan itself. The felt "more hits = slower" is real
   only at that extreme; everything else is a flat 20 s wall.
2. **An identical repeat query re-scans from scratch.** `okay` ran twice
   back-to-back, 20,942 ms the second time. `search()` serves the per-query
   snapshot only when `offset > 0`; a re-issued query at offset 0 always
   re-derives. That was a sound trade when re-deriving cost 1.2 s. At 20 s it
   is the single cheapest thing on this page to fix.
3. **Typing serializes full scans.** The drawer debounces 400 ms and there is
   no cancellation of an in-flight search, so a pause mid-word starts a 20 s
   scan that nothing stops when the next keystroke arrives. The log shows the
   prefix scans (`co`, `codemirroredito`, `codemirroreditor`) each running to
   completion in sequence. Several of those queued back to back is the
   "spinning for five minutes" report — it is not one slow query, it is a
   backlog of superseded ones.
4. **The first search after a stale index pays a synchronous full rebuild.**
   91,386 ms of rebuild, then a 19,012 ms scan, for 110,543 ms to first result.
   The rebuild itself is pre-existing behaviour and not this plan's target, but
   it sets the worst-case first impression.

### Which build these numbers are from

These are the streamed scan with the **raw-line lowercase** prefilter (index
schema 4.1.0). The keyed `textLower` prefilter (schema 4.2.0) has landed in the
repo but the running extension host had not picked it up, and the on-disk index
is still 4.1.0. The predecessor plan projects the keyed variant at ~2.2x faster,
so expect roughly **9–10 s** per query after the next reload and its one-time
rebuild — better, still an order of magnitude off the resident 1.2 s, and still
~190 s per 20-search session. **This plan is needed either way.**

It also corrects the predecessor's closeout: that doc records 9,277.9 ms for a
first streamed search and 8,793.7 ms warm, for the _same_ raw-line variant these
logs show at 20.2–21.5 s. The live number is the trustworthy one; the closeout
figure should not be used as a baseline.

## Why results can be streamed — the structural fact that makes this work

Nothing about the current design requires a full scan before the first row.
Two existing properties combine:

- **One shard is exactly one run.** `getDocumentsShardPath` hashes the run's
  manifest path, so a shard file holds only that run's documents.
- **Every document in a run shares that run's `startedAt`, which is the primary
  sort key.** `compareMatches` orders by `startedAt` desc, then `timestampMs`
  desc, then `sequence` desc.

So visiting shards in **descending `startedAt`** yields matches already in
primary-sort order: every document of a newer run outranks every document of an
older one. Only the intra-run tie-breaks need sorting, and that is one run's
documents at a time.

`manifest.json`'s `indexedRuns` entries **already carry `startedAt`** alongside
`manifestPath`, so the scan order is derivable today with no schema change and
no extra read — it is a sort of 1,560 in-memory entries.

The consequence: a first page of 50 rows costs _time to find 50 matches in the
most recent runs_, not time to read 1.6 GB. For a term used recently — the
common case for this product — that is a handful of shards.

## Options

### A. Recency-ordered scan with early termination

Order shards by `startedAt` desc, stream in that order, emit the page as soon
as it is full, and stop.

- **Fixes:** the flat 20 s floor for any query whose hits are not all ancient.
  Turns the common case into tens of milliseconds.
- **Memory:** unchanged — still O(page).
- **Does not fix:** a query with no matches, or matches only in the oldest
  runs, still reads everything. That tail is what B and E are for.
- **Sharp edge — `totalCount`.** The response contract carries an exact
  `totalCount`, and the virtualized list sizes its scrollbar from it. Early
  termination cannot know it. This is the real cost of the option and must be
  designed, not discovered: either report a lower bound and refine it from a
  background continuation, or change the list to tolerate an open-ended total.
- **Sharp edge — equal `startedAt`.** Two runs can share one; those shards must
  be processed as a group before emitting, or their interleaved order is wrong.
- **Sharp edge — deep paging.** Today `offset > 0` is served from a complete
  snapshot. With early termination the snapshot is a prefix, so paging past it
  must resume the scan from a retained cursor (shard index + position) rather
  than restart it.

### B. Bounded most-recent-run document cache

Hold parsed documents for the most recent N runs in the extension host, sized
to a budget, and stream only past its edge.

- **Sizing:** the resident measurement was ~2,157 MB of heap for 1,672,357
  documents, about **1.35 KB per document**. A **1 GB** budget therefore holds
  roughly 750,000 documents — near enough half the index, and the half that is
  searched most.
- **Fixes:** the remaining scan cost for recent hits, and makes a repeat query
  effectively free.
- **Composes with A rather than competing:** the cache is a prefix of the same
  recency-ordered scan, so it is one code path with a fast front end — not the
  two-correctness-paths split that made the predecessor plan reject bounded
  residency. That objection does not apply once the scan is ordered.
- **Invalidation is already solved:** an incremental rebuild rewrites specific
  per-run shards, so evicting those runs from the cache is exactly the shard
  splice the predecessor plan deleted, reintroduced as a cache concern where a
  miss is a slow read rather than a wrong answer.
- **Cost:** reopens a bounded, deliberate share of the memory this product just
  spent a plan removing. It must stay a hard cap with eviction, and it must be
  measured against the OOM history in
  `dev/implemented/HISTORY_SEARCH_PERFORMANCE_PLAN.md`.

### C. Serve a repeat query from the existing snapshot

Allow `offset === 0` to hit the per-query snapshot when the index has not
changed, instead of only `offset > 0`.

- **Fixes:** finding 2 above outright — a re-issued query drops from ~20 s to
  the freshness check (~530 ms in these logs), a ~40x win for a few lines.
- **Sharp edge:** the current comment justifies always re-deriving at offset 0
  so a new query sees a fresh index. Gate the reuse on the freshness check the
  search already performs, so a changed index still re-derives.

### D. Cancel superseded in-flight searches

Abort a running scan when a newer query for the same drawer arrives, and raise
the debounce above its current 400 ms while scans remain expensive.

- **Fixes:** finding 3 — the queued backlog that reads as a hang.
- **Cost:** the scan loop needs a cancellation signal threaded through
  `streamHistorySearchDocuments`; it has no abort today.
- **Note:** this is a mitigation, not a cure. With A landed, scans are short
  enough that cancellation matters much less.

### E. Trigram postings sidecar

The predecessor plan's Option B, unchanged: the rebuild worker emits per-shard
postings from lowercased trigrams to document offsets; a query intersects
postings and reads only candidates.

- **Fixes:** the tail A cannot — rare terms and no-match queries become
  sublinear instead of a full read.
- **Cost:** highest complexity here, its own schema version, its own
  incremental-update story, and a fallback for queries shorter than the trigram
  width (`MIN_QUERY_LENGTH` is 2).

## Recommendation

Land in this order, because the cheap ones are felt immediately and the
expensive one is easier to validate once the noise is gone:

1. **C and D first.** Small, self-contained, and together they remove the
   repeat-scan and the queued-backlog hang that produce the worst of the
   current experience. Neither depends on A.
2. **A next — this is the actual fix.** Recency-ordered scan with early
   termination, including the `totalCount` contract change it forces. Treat the
   UI side as part of the same work: `historySearchResults` in `uiStore` is
   already a sparse listing indexed by absolute position, so appending
   progressively delivered rows fits the existing shape rather than needing a
   new one.
3. **B within a 1 GB cap**, measured, once A is in and the cache's job is
   narrow: absorb the first page of recent-term queries entirely.
4. **E only if the tail still hurts** after 1–3. Do not start here.

A target worth holding the work to: a recent-term query should return its first
page in well under a second, and a 20-search session should cost seconds in
aggregate rather than minutes.

## What must not break

- **The no-false-negative prefilter invariant**, and its coupling to the index
  schema: the keyed prefilter only works on shards carrying `textLower`, and
  `streamHistorySearchDocuments` takes `hasPersistedLowercaseKey` for exactly
  that reason (see `.github/instructions/orchestration.instructions.md`). An
  ordered or early-terminating scan must keep passing it honestly.
- **Sort order within a run** — `timestampMs`/`sequence` ties, carried
  alongside projected results because `HistorySearchResult` lacks those fields.
- **Dedupe semantics.** The dedupe key comes from the projected result, so a
  row's deduped ordinal depends on everything ahead of it. Ordered scanning
  preserves this (everything ahead is emitted first); unordered early
  termination would not.
- **Rebuild-progress reporting** to the UI on the synchronous rebuild path.
- **`HistorySearchService.searchLegacy`** stays the unavailable-index fallback,
  unchanged.

## Non-goals

- **No return to a fully resident index.** The 2.16 GB baseline and its two
  confirmed heap-OOM crashes are what the predecessor plan removed; option B is
  a hard-capped cache, not a reversal.
- **No SQLite/FTS5**, for the packaging reasons the predecessor plan records.
- **No reduction in what gets indexed.**
- **Not the rebuild.** The 91 s full rebuild is real but separate; this plan is
  about query latency. Note that `dev/backlog/HISTORY_SEARCH_TRUNCATED_TEXT_MATCH_PLAN.md`
  would grow document count, so sequence it after this work, not before.

## Acceptance criteria

- [ ] A recent-term query returns its first page in under 1 s on the 1,560-run
      workspace — measured from the session log, not asserted.
- [ ] Query latency is no longer flat with respect to selectivity: a 21-match
      recent query is materially faster than a full-index pass.
- [ ] An immediately repeated query does not re-scan.
- [ ] Typing a multi-word query does not leave superseded scans running.
- [ ] Extension-host working set stays within the chosen cache budget (1 GB if
      option B lands, near-zero growth if it does not), measured after a
      20-search session.
- [ ] Offset paging still reaches the last page of a several-thousand-result
      search without walking every page.
- [ ] Result ordering and dedupe are identical to the current implementation
      for a query that scans the whole index.
- [ ] A 20-search session costs seconds in aggregate, compared with the ~416 s
      recorded above.
