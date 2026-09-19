# History Search Index Residency Plan

**Status:** Backlog — staged for implementation (2026-09-18)
**Priority:** P1
**Predecessor:** `dev/implemented/HISTORY_SEARCH_PERFORMANCE_PLAN.md` (worker
isolation, incremental rebuild, shared registry). This doc covers the one
structural problem that plan did not touch.

## The problem in one sentence

`HistorySearchIndexService` answers a query by holding **every indexed
document in the extension host's heap**, so the first search of a session pays
the cost of reading and parsing the entire on-disk index, and every session
thereafter carries that index as resident memory.

## Measured on a real workspace (2026-09-07)

Workspace: 1181 lineages, 1430 runs, 983,404 documents, **976 MB** of
`documents/*.jsonl` shards under
`~/.ctrlyoke/projects/ctrlyoke-81d730fe53ae/.search-index/`.

| Measurement                                    | Value                         |
| ---------------------------------------------- | ----------------------------- |
| Cold `loadIfPossible()` (first ever read)      | **31,257 ms**                 |
| Warm `loadIfPossible()` (OS page cache hot)    | **5,544 ms**                  |
| Extension-host working set with index resident | **1,850 MB**                  |
| Freshness check (`isManifestFresh`)            | ~350 ms (2 stats x 1430 runs) |
| In-memory match pass for `"codemirror"`        | 602 ms (983,404 documents)    |

The 31 s figure is the one a user actually feels: it is the whole of the
"search takes 20+ seconds to start" report, and it happens again on every
extension-host restart.

Everything else in that report was fixed in the change that produced this doc
(see "What already shipped" below); this is the residue.

## What already shipped, and why it does not solve this

Three fixes landed together and are worth stating precisely so this doc is not
mistaken for a re-run of them:

1. **Per-run shard splice.** An incremental rebuild now reports which shard
   files it rewrote or deleted, and a host holding the index replaces only
   those runs. Measured on the workspace above: a one-run incremental rebuild
   went from a **5,688 ms full reload** to a **7 ms splice**. This was the
   "search almost does a re-index eventually" symptom — with a workflow
   running, the freshness check failed on nearly every search and each one paid
   a full reload.
2. **Random-access offset paging.** `HistorySearchQuery.cursor` became
   `HistorySearchQuery.offset`, and `historySearchResults` in `uiStore` became
   a sparse listing indexed by absolute position. Dragging the scrollbar to the
   end of a 3,845-result search went from **77 sequential round trips (~77 s)**
   to **one request**, with the last row rendered in under 520 ms.
3. **Per-query match snapshot.** The full deduped result list is retained per
   query, and an `offset > 0` request is served from it with no readiness check
   and no rescan (which also makes pagination stable against a concurrent
   rebuild). Page cost went from **~950 ms** to **1 ms**.

None of that reduces residency. Fix 1 avoids re-reading the index; fix 3 avoids
re-scanning it. Both still assume the whole index is in the heap.

## Why this is the remaining risk, not just a slow path

`.github/instructions/orchestration.instructions.md` already flags this service
as having OOM'd the extension host, and the predecessor plan documents two
confirmed `CALL_AND_RETRY_LAST` heap-OOM crashes. Those were traced to
_rebuild_ allocation churn and fixed by moving rebuilds into a worker. But a
1.85 GB resident baseline in the extension host is the other half of the same
exposure: it is the elevated baseline that made an otherwise ordinary
allocation tip over in Incident #2. The worker now owns the churn; the host
still owns the residency.

Note the shape of the growth: 976 MB of JSONL becomes ~1.85 GB of live V8
objects, and history is unbounded by default (`runs.maxRuns` is `-1`).

## Options

### A. Stream the shards per query; hold no documents resident

Never load documents. For each query, stream every shard and test lines
directly, parsing only the ones that could match.

- **Memory:** O(page), not O(index). Removes the 1.85 GB baseline outright.
- **Cold start:** no 31 s load; the first search costs one pass instead.
- **Cost per query:** a full read of the shard set. Warm page cache makes this
  far cheaper than the 5.5 s parse (no object allocation), but it is a real
  per-query cost where today a warm session pays 602 ms.
- **Sharp edge — case-insensitivity.** The current match is a
  case-insensitive substring test. A raw-buffer prefilter cannot lowercase
  976 MB cheaply per query. Needs either a lowercased search key written into
  each shard by the worker (larger shards, no query-time cost) or a
  case-insensitive buffer search.
- **Sharp edge — JSON escaping.** A prefilter over raw JSONL lines can
  false-negative when the query contains characters JSON escapes (`"`, `\`,
  newline). Escape the query the same way `JSON.stringify` would before
  prefiltering, and verify every candidate by parsing it and re-running the
  real `document.text.includes()` test. False positives are harmless (an extra
  parse); false negatives are silent wrong answers, so this must be covered by
  tests with quote/backslash/newline queries.
- **Interaction with the shipped snapshot:** paging still works unchanged —
  the snapshot is built once per query from the streamed pass, exactly as it is
  built today from the resident pass.

### B. Trigram (or token) postings sidecar

Have the rebuild worker emit, per shard, a compact posting list mapping
lowercased trigrams to document offsets. A query intersects postings for its
trigrams, then reads and verifies only the candidate documents.

- **Memory:** postings are far smaller than documents; a query touches a small
  fraction of the index.
- **Cost per query:** sublinear — the only option here that actually is.
- **Cost to build:** more rebuild work and a larger on-disk index.
- **Complexity:** highest of the three. Needs its own schema version, its own
  incremental-update story per shard, and careful handling of queries shorter
  than the trigram width (`MIN_QUERY_LENGTH` is 2, so a 2-character query has
  no trigram — it must fall back to a scan).

### C. Move residency into a long-lived search worker

Keep the current in-memory design but host it in a `worker_threads` worker that
also owns querying, returning only pages over the channel.

- **Fixes:** extension-host residency and crash containment.
- **Does not fix:** the 31 s cold load, or the total memory the machine spends.
- **Regression risk:** the predecessor plan explicitly warns against a
  long-lived rebuild worker because it relocates baseline creep rather than
  removing it. A long-lived _query_ worker holding 1.85 GB has that same shape.

### D. Bounded residency (most-recent-N runs) with a disk fallback for the rest

- **Fixes:** caps memory with a small change.
- **Does not fix:** correctness is now split across two code paths with
  different performance and (historically, see `searchLegacy`) different
  behavior. The predecessor plan's non-goals section already resists growing
  the fallback path's responsibilities.

## Recommendation

Pursue **A**, with a measurement spike first, and treat **B** as the follow-on
only if A's per-query cost proves unacceptable on this workspace.

The spike is small and worth doing before committing to a design: over the real
976 MB shard set, measure (1) a full streaming read with a raw substring
prefilter and (2) the same with a lowercased-key column added to each shard.
If a warm query lands in the same order as today's 602 ms resident scan, A wins
outright — it is strictly less code than B, removes 1.85 GB, removes the 31 s
cold start, and keeps one query path rather than two.

A is also the only option that composes cleanly with what already shipped: the
per-query snapshot means a streamed pass happens once per query, not once per
page, so A's per-query cost is paid at the same frequency the resident scan is
paid today.

## Implementation plan (decided 2026-09-18)

Option A is the design being built. The points below were checked against the
current code and are the contract the staged work follows; the spike (first
step) may change the _prefilter_ choice, not this shape.

### What disappears

Residency is entirely private to `HistorySearchIndexService` — no consumer
touches it (`HistorySearchService.search` and `OutputHistoryManager`'s refresh
are the only callers, both via `HistorySearchIndexServiceRegistry`). So A
deletes rather than adds:

- `shardDocuments` / `documentCount` / `setShardDocuments` /
  `readDocumentShards` / `readDocumentShard`.
- `applyIncrementalShardDelta` and `removeShard`. The per-run shard splice
  exists only to patch resident documents; with nothing resident, a rewritten
  shard is simply read by the next query. `HistorySearchIncrementalShardDelta`
  and the worker's `rewrittenShardNames`/`removedShardNames` reporting become
  unused and go with it.
- `rebuild(..., { retainDocuments })` and
  `HistorySearchRebuildWorkerData.retainDocuments`. The worker never read that
  flag for anything but a log line — it always streams shards to disk — and
  the host-side split between the one reader and the write-only refreshers is
  exactly what residency created.
- `loadIfPossible` shrinks to a manifest read. It is still needed:
  `ensureReady` compares the manifest for freshness, and a schema-version
  mismatch must still force a rebuild.

### What replaces the match pass

`collectMatches` becomes a streamed pass over the shard directory listing,
read live per query rather than from a loaded map:

1. For each shard, stream it line by line (`streamFileLines` already handles
   the U+2028 / lone-CR hazards documented in `src/utils/TextLines.ts`; a raw
   `Buffer` reader is acceptable if the spike shows it materially faster, but
   it must reproduce `LINE_BREAK_PATTERN` exactly).
2. Apply a **prefilter** to the raw JSONL line. It must never false-negative;
   a false positive costs only one wasted `JSON.parse`.
3. Parse survivors and re-run the real
   `document.text.toLowerCase().includes(query)` plus `matchesFilters`.
4. Project, dedupe, and sort exactly as today.

Tolerate a shard that vanishes mid-pass (`ENOENT`) the way `readDocumentShard`
does today — a concurrent rebuild replaces shards by atomic rename, so each
shard read sees either the old or the new content, never a torn one.

### Sort keys are the one non-obvious break

`compareDocuments` sorts on `startedAt`, then `timestampMs`, then `sequence`.
`HistorySearchResult` carries `startedAt` but **not** `timestampMs` or
`sequence`. Today that is free because the sort runs over resident documents
before projection. A streaming pass cannot retain the documents, so it must
carry those two sort keys alongside each projected result (an internal type —
do not widen the wire-facing `HistorySearchResult`) and sort on them. Getting
this wrong silently reorders results within a run, which no existing test
would catch; the staged work adds one that does.

### Peak memory during the pass

Residency is not the only exposure: `collectMatches` also materializes the
full projected result list, and `MAX_SNAPSHOT_RESULTS` (50,000) governs only
whether that list is _retained_, not whether it is built. Keep today's
behaviour (build the full list, retain it only under the cap) unless the spike
shows the peak is itself a problem — a degenerate query over ~1M documents is
the case to measure. Paging past the cap re-runs the pass, which is now a disk
pass instead of an in-heap scan; that is an accepted cost for a

> 50,000-result query and matches the current non-retained path.

### Prefilter correctness (the part tests must pin down)

- **JSON escaping.** The query must be escaped the way `JSON.stringify` writes
  it before being compared against a raw line: a double quote becomes an
  escaped quote, a backslash becomes a doubled backslash, newline/tab become
  their two-character escapes, and other control characters become `\uXXXX`
  escapes.
- **Case.** ASCII case-folding during the comparison is cheap; non-ASCII case
  folding is not byte-comparable. When the query contains non-ASCII letters
  the prefilter must degrade permissively (prefilter on an ASCII-only run of
  the query, or skip prefiltering entirely for that query) rather than risk a
  miss.
- These are the only two places option A can silently return wrong answers, so
  they get direct tests, including a property-style check asserting the
  prefilter is true whenever the real `includes()` test is.

## Non-goals

- **No SQLite/FTS5.** A native module means per-platform prebuilds in a VS Code
  extension that already ships a CLI binary, an MCP server, and a worker
  bundle. The problem does not justify that packaging burden.
- **No change to `HistorySearchService.searchLegacy`.** It stays a safety net
  for when the index is unavailable, per the predecessor plan's non-goals.
- **No reduction in what gets indexed.** Text is already capped at
  `MAX_INDEXED_TEXT_LENGTH`; the size here is document count, not per-document
  size, and dropping documents changes what users can find.

## Acceptance criteria

- [ ] A first search in a fresh extension host on a 1400+ run workspace returns
      results without a multi-second index load — measured, not asserted.
- [ ] Extension-host working set after several searches on that workspace stays
      within a few hundred MB of its pre-search baseline.
- [ ] Case-insensitive substring matching is unchanged for queries containing
      `"`, `\`, and newlines, with tests for each.
- [ ] Offset paging and the per-query snapshot keep working: a jump to the last
      page of a several-thousand-result search still costs one request.
- [ ] `search()`'s rebuild-progress reporting to the UI still fires when a
      rebuild is needed.
- [ ] Results are identical to the resident implementation over the same index,
      including ordering within a run (`timestampMs`/`sequence` ties).
- [ ] Correct results after an incremental rebuild are still covered, even
      though the shard-splice mechanism that made them fast is deleted.
