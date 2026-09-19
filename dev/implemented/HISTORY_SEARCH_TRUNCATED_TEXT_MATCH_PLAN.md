# History Search Truncated-Text Match Plan

**Status:** Implemented. **Option decided: B** (2026-09-19), on
the measurement spike below; the acceptance criteria's measurement gate is met,
and "Implementation design (settled)" below fixes the design against the code
that exists today.

**As built:** The settled option-B design shipped without material deviation.
`overCapCandidateCount` records the number of source strings shortened during
indexing — a durable has-hidden-text signal, not an exact candidate count — as
specified below. Two things the design did not anticipate: threading the
truncation counter revealed that `truncateHistorySearchEvent` had **no
`CLI_OUTPUT_EVENTS_APPENDED` branch at all**, so streamed-append events reached
the extractor untruncated (harmless for stored documents, which the extractor
capped anyway, but it skipped the pre-truncation memory saving) — that branch
now exists; and the deep scan's workflow-name resolver is memoized per scan
(`HistorySearchIndexService.createWorkflowNameResolver`) over a shared
`WorkflowLineageRepository.readWorkflowDisplayName`, because a deep query can
visit every run in the history and the descriptor-read-plus-fallback pair had
accumulated three copies.
**Priority:** P2
**Related:** `dev/implemented/HISTORY_SEARCH_PERFORMANCE_PLAN.md` (introduced
`MAX_INDEXED_TEXT_LENGTH` as an OOM guard — background for why this cap exists
at all). `dev/implemented/HISTORY_SEARCH_INDEX_RESIDENCY_PLAN.md` and
`dev/implemented/HISTORY_SEARCH_RESPONSIVE_QUERY_PLAN.md` — both landed since
this plan was written, and together they change what option A actually costs;
see "Sequencing" below for why, and "Measurement spike" for what it cost when
actually measured.

## The problem in one sentence

`HistoryCandidateExtractor` caps every candidate's text at
`MAX_INDEXED_TEXT_LENGTH` (2000 chars) before it is stored and matched, so a
query term that only appears after character 2000 of a long candidate is
**silently invisible to history search** — not ranked low, not omitted with a
note, just absent, even though `OutputFindBar` finds it instantly because it
searches the full rendered text with no cap.

## How this was found

Investigating a user report that `OutputFindBar` found 369 occurrences of a
term in one run while the global history search drawer, filtered to that same
workflow, found only 32. Two real bugs were in play:

1. `CLI_OUTPUT_EVENTS_APPENDED` (streamed structured events) wasn't indexed at
   all — **fixed** in the change that produced this doc; see
   `.github/instructions/orchestration.instructions.md`'s `<searchAndRecovery>`
   section.
2. This truncation gap — fixed by the option-B implementation recorded here —
   was the subject of this doc.

Most of the raw 369-vs-32 gap turned out to be an intentional, unrelated
design difference (history search reports one result per matching event/field,
`OutputFindBar` reports one per literal occurrence — see the same
instructions bullet). **That difference is now stated in the drawer itself**
("Each result is one matching event, not one occurrence — open a result to
highlight every occurrence in that run's output", in `HistorySearchDrawer`'s
sticky header), precisely so the next person doing this arithmetic starts from
the real gap instead of this one. But truncation was not a semantics
difference — it was real, measured data loss:

| Measurement (one real run, `ACCESSIBILITY_AND_TESTABILITY_PLAN`) | Value         |
| ---------------------------------------------------------------- | ------------- |
| Longest single candidate text (one structured event's content)   | 171,222 chars |
| Documents whose _capped_ text matched the query                  | 85            |
| Documents whose _uncapped_ text matched the query                | 200           |
| Documents with a match that exists only past character 2000      | **115**       |

That's 115 otherwise-real matches — in one run, for one query — made
unreachable by the cap. Long AI-generated planning/response text (the
171 KB example above) is a completely ordinary shape for this product, not an
edge case, so this isn't rare. The workspace-wide spike below confirms how far
from rare: **68% of all indexed-candidate text in a real 1,563-run history is
past the cap**, and 83% of runs contain at least one over-cap candidate.

## Measurement spike (2026-09-19)

`scripts/spike-history-search-truncation.mjs` re-extracts every candidate from
a real history's `events.jsonl` with the production `HistoryCandidateExtractor`
and **no** `maxTextLength` — the only way to recover the pre-truncation lengths
the index itself threw away — and sizes each option against the index that was
actually built from it. Growth is projected from measured constants (the real
per-document non-text line cost and JSON escape factor of a schema 4.2.0 index),
and cache fit uses the real `estimateHistorySearchDocumentBytes`.

Run against this project's own user-scoped history
(`~/.ctrlyoke/projects/ctrlyoke-<hash>`), 3.7 GB of runs and a 2.29 GB index:

| Today                                          | Value                       |
| ---------------------------------------------- | --------------------------- |
| Runs indexed / documents / index size          | 1,563 / 1,682,723 / 2.29 GB |
| Candidates exceeding `MAX_INDEXED_TEXT_LENGTH` | 169,686 (10.1%)             |
| **Candidate text never indexed**               | **1.47 B chars — 68.25%**   |
| Runs with at least one over-cap candidate      | **1,302 (83.3%)**           |
| Longest single candidate                       | 1,032,121 chars             |
| Runs resident in the 320 MB document cache     | 50                          |

The 68% figure is the one that reframes this plan: the capped index is not a
complete index with a rare gap at the tail, it is **a fast prefilter over a
minority of the corpus**. The three-number gate from the acceptance criteria,
per option (overlap 200 chars for A):

| Option                    | Added documents      | Index on disk              | Runs in 320 MB cache |
| ------------------------- | -------------------- | -------------------------- | -------------------- |
| A — overlapping windows   | +911,055 (**1.54x**) | 2.29 → 6.09 GB (**2.66x**) | 50 → **29** (−42%)   |
| B — capped + per-run scan | **0**                | **unchanged**              | **50** (unchanged)   |
| C — first/last anchors    | +100,960 (1.06x)     | 2.29 → 2.68 GB (1.20x)     | 50 → 45 (−10%)       |

Option A's disk multiplier is larger than its document multiplier because it is
not merely adding documents, it is storing the 68% of text that is currently
discarded — twice over, since 4.2.0 writes `textLower` beside `text`. Raising
the overlap to 400 chars moves it to 2.88x; overlap sizing is a second-order
knob, the corpus shape is the cost.

Option C buys very little: it still leaves **1.267 B chars unindexed — 86% of
today's loss** — because the interior of a long candidate is exactly where the
missing text is. It is a 1.2x index for a 14% dent in the problem.

The number that decides it is option B's fallback cost, which this plan had
flagged as its one unknown ("historically-dangerous uncapped disk scan… paid
for one run's events"). Measured, an uncapped single-run scan is interactive:

| Run size percentile | `events.jsonl` | Uncapped scan |
| ------------------- | -------------- | ------------- |
| p50                 | 0.47 MB        | 3 ms          |
| p90                 | 6.29 MB        | 34 ms         |
| p99                 | 31.6 MB        | 178 ms        |
| max                 | 87.2 MB        | 500 ms        |

The whole 3.7 GB history re-extracts uncapped in ~38 s, which also bounds the
worst case for a rare-term deep scan that walks every run.

## Why the fix isn't "raise or remove the cap"

`MAX_INDEXED_TEXT_LENGTH` is not an arbitrary tuning knob. It was added after
two confirmed extension-host `CALL_AND_RETRY_LAST` heap-OOM crashes during
`HistorySearchIndexService` rebuilds (see the predecessor plan). A workspace
in the same investigation had 983,404 documents resident at once; multiplying
per-document text size by that count is exactly the "megabyte-per-event
verbatim" pattern that caused the crashes. Any fix here has to keep the
per-document memory bound intact, not just make it bigger.

## Options

### A. Window long candidates into multiple bounded, overlapping documents

When a candidate's text exceeds the cap, split it into N windows of
`MAX_INDEXED_TEXT_LENGTH` each (not one truncated prefix), with a fixed
overlap between consecutive windows so a match straddling a window boundary
isn't missed. Only candidates that actually exceed the cap are split — the
overwhelming majority of candidates (short prompts, single tool calls, status
messages) are completely unaffected, so this does not multiply the size of a
typical index.

- **Coverage:** complete, modulo one sharp edge below.
- **Memory per document:** unchanged — still bounded at `MAX_INDEXED_TEXT_LENGTH`.
- **Total document count:** grows only for candidates that were already being
  truncated — **measured at +911,055 documents (1.54x) and a 2.66x index** on a
  real 1,563-run history. The "overwhelming majority of candidates are
  unaffected" framing above held (only 10.1% exceed the cap), but it understated
  the cost badly: those 10.1% carry 68% of the text.
- **Sharp edge — overlap sizing.** A window overlap shorter than the query
  loses matches that straddle a boundary; too generous an overlap multiplies
  storage. A fixed overlap (e.g. a few hundred chars) covers realistic search
  terms; a query longer than the overlap can still be missed at a boundary.
  This is a smaller, bounded version of the same trade-off the cap itself
  makes — worth stating explicitly in the UI or docs rather than silently
  reintroducing a scaled-down version of today's silent gap.
- **Dedupe interaction:** `getHistorySearchDocumentDedupeKey` includes
  `matchSnippet`, which is derived from match position. Windows from the same
  candidate naturally produce different snippets (different text), so they
  won't spuriously dedupe into one one result — but a query matching in the
  overlap region of two adjacent windows _will_ currently produce two
  near-identical results. Needs either a window-index-aware dedupe key or
  snippet-position collapsing for adjacent windows.

### B. Two-tier: capped index + on-demand full-text fallback per run

Keep today's single capped document per candidate unchanged (no growth to the
persisted index), but track whether a candidate was truncated
(`document.truncated: true` alongside the existing fields). When a query
matches nothing in a run that has truncated documents, surface an explicit
"this run has content that wasn't fully indexed — search it directly?" action
that runs an uncapped, single-run scan (close in shape to
`HistorySearchService.searchLegacy`, but scoped to one run instead of the
whole workspace, so its historically-dangerous "uncapped disk scan" cost is
paid for one run's events, not the whole history).

- **Memory:** no change to the persisted index's steady-state size, and none to
  the document cache's recency window (measured: 50 runs, unchanged).
- **Coverage:** complete, but discovery is opt-in rather than a single query
  surfacing every match across the workspace in one pass — a real regression
  from "one search box, one flat result list" if this is the only fix. See
  "What the spike changes about option B" for why the trigger cannot be
  per-run-matched-nothing as written here.
- **Complexity:** lower than A. No windowing, no dedupe interaction, no
  overlap tuning.
- **User experience:** requires new UI (the "search this run directly"
  affordance) and a per-run scan path that does not currently exist.
- **Fallback cost:** measured at 3 ms (p50) / 34 ms (p90) / 178 ms (p99) /
  500 ms (largest run, 87 MB) — the "historically-dangerous uncapped disk scan"
  worry does not survive being scoped to one run.

### C. Anchor windows (first + last N chars only)

Cheaper compromise: instead of full chunking, index the first
`MAX_INDEXED_TEXT_LENGTH` chars (today's behavior, unchanged) plus a second
document for the last `MAX_INDEXED_TEXT_LENGTH` chars when the candidate
exceeds `2 * MAX_INDEXED_TEXT_LENGTH`.

- **Memory:** at most 2x today's per-candidate cost, never more, regardless of
  how long the source text is. Measured: +100,960 documents (1.06x), 1.20x on
  disk, cache window 50 → 45 runs.
- **Coverage:** catches matches at the start or end of long text (openings and
  conclusions of long responses, which is where search terms often land) but
  not the middle — the 171 KB example above would still lose matches sitting
  in the interior. Strictly better than today, provably incomplete, and
  **measured, not very much better**: 1.267 B chars (86% of today's loss) stay
  unindexed. The premise that terms "often land" at the start or end does not
  survive a corpus whose average over-cap candidate is ~10,700 chars — two
  anchor windows cover 37% of one, and far less of the long tail.
- **Complexity:** lowest of the three — no overlap tuning, no dedupe
  interaction beyond what already exists for multiple documents per event.

## Sequencing: both predecessor plans have landed

Two changes since this plan was written move the numbers it reasons about, in
opposite directions. This section framed the questions the spike then answered;
it is kept because it explains _why_ each measured number matters, and because
anything that later reopens windowing has to clear these same three costs
again.

### Residency is gone, so windowing no longer grows resident heap

`dev/implemented/HISTORY_SEARCH_INDEX_RESIDENCY_PLAN.md` replaced the
extension-host's resident-document map with streamed shard queries. Option A
above (windowing) therefore no longer increases permanently resident heap —
the additional documents are read from disk as part of the same streamed pass.
Residency is no longer a reason to block this plan. Option B still avoids
index growth, and Option C still has bounded growth (at most 2x for affected
candidates).

### But three newer costs replaced it, and none of them existed before

1. **Every document is now stored twice.** Index schema 4.2.0 writes a
   serialized lowercase `textLower` key alongside `text` so the scan's
   prefilter can compare against it without lowercasing each raw line.
   Sampling 40 real shards measured `text` at 41% of payload, so the shard set
   grew ~44.6% when the key landed. **Each window option A adds therefore
   costs ~1.45x what this plan originally assumed on disk.** The measurement
   spike in the acceptance criteria has to be run against a 4.2.0 index, not
   against the older numbers — it was, and the doubling is why A's on-disk
   multiplier (2.66x) runs well ahead of its document multiplier (1.54x).
2. **The document cache's hit rate is a function of documents per run.**
   `HistorySearchDocumentCache` holds parsed documents for the most recent
   runs within a budget (`runs.historySearchCacheMb`, default 320 MB, chosen
   by measurement — see the responsive-query plan's re-tuning section).
   Windowing puts more documents in each recent run, so **fewer runs fit** —
   and by more than document count alone suggests, because
   `estimateHistorySearchDocumentBytes` sums _every_ string field, so
   `textLower` counts against the budget too —
   and the cache is exactly what takes a recent-term query from ~20 s to
   4-15 ms. This is the cost most likely to be missed, because it shows up as
   a latency regression on queries that have nothing to do with long
   documents. The spike must measure cache-resident run count before and
   after, not just index size. **Measured, and it is the worst of the three:
   the cache holds 50 of 1,563 runs today and 29 under option A** — a 42% cut
   to the recency window that is the whole reason a recent-term query answers
   in milliseconds.
3. **More documents per run means more lines scanned before the page fills.**
   The scan is recency-ordered and stops at `offset + limit`, so it reads
   whole runs at a time. Windowing does not change which runs it visits, but
   it does change how much each one costs. Bounded and probably small; **not
   measured** — it is moot under the chosen option, which adds no documents,
   and would have to be measured by anything that reopens windowing.

### And windowing collides with the counting model the UI now states

`HistorySearchDrawer` now tells the user, in prose, that each result is one
matching event. Option A breaks that: a long response split into N windows
produces up to N results for what the user sees as one event, and the
overlap region can produce two near-identical results for a single match
(already flagged under option A's dedupe interaction). **Whichever option
ships has to either preserve the one-result-per-event promise or change that
copy** — silently making the sentence false is worse than the gap this plan
exists to close, because it re-breaks the exact comparison that first
surfaced this bug. Option C has the same problem in miniature (two anchor
windows, up to two results per event); option B does not have it at all,
which is a point in its favour that did not exist when this plan was
written.

## Decision: option B

The spike settles it, and not narrowly. **A is rejected**: it costs a 2.66x
index (2.29 → 6.09 GB on one developer's history), cuts the document cache's
recency window by 42%, and breaks the one-result-per-event model the drawer now
states in prose — three real prices, two of which land on queries that have
nothing to do with long documents. **C is rejected**: it closes 14% of the gap
for a 1.20x index and inherits a miniature version of the same counting-model
problem, which is the worst ratio of the three. **B is chosen**: zero added
documents, zero index growth, no cache impact, no change to the counting model,
and the one cost this plan could not previously size — the uncapped per-run
scan — measures at 3–500 ms.

That last number is the decisive one. B was originally the conservative
fallback whose per-run scan was an unpriced risk; measured, it is simply cheap,
and A's "complete coverage" turns out to be the expensive way to buy something
B also delivers.

### What the spike changes about option B

The option as sketched above needs three corrections before it is built. None
of them change the choice; all of them were invisible before the measurement.

1. **The trigger cannot be "the query matched nothing in this run."** At 68%
   text loss and 83.3% of runs affected, a run routinely holds _both_ indexed
   and hidden matches for the same query — that is literally the case that
   produced this plan (85 capped-matching documents vs 200 uncapped, in a run
   that matched plenty). Gating the fallback on an empty result would have
   hidden the exact bug it exists to fix.
2. **The truncation flag belongs in the index manifest, not on each document.**
   A per-run over-cap count in `HistorySearchIndexManifest`'s `indexedRuns`
   entry is ~1,563 numbers, is already loaded before any shard is read (the
   shard-order pass reads it), and costs nothing in the shards. A per-document
   `truncated: true` is only visible _after_ paying the shard read it is meant
   to inform, and pays `textLower`-style storage on every document to describe
   10.1% of them.
3. **83.3% of runs qualify, so this is not a rare-exception badge.** A
   per-result "this run wasn't fully indexed" notice would appear on nearly
   every row and read as noise. The affordance should be query-level — a deep
   search the user turns on for the query they are actually running — layered
   over the recency-ordered, abortable, incrementally-reported scan that
   `HISTORY_SEARCH_RESPONSIVE_QUERY_PLAN` already built, so it inherits the
   same early stop (a recent-term query touches a handful of runs, a few
   hundred ms) and the same cancellation semantics. The ~38 s full-history
   re-extraction bounds its worst case, and it streams partial results, which
   is strictly better than the `searchLegacy` disk scan it resembles.

4. **Dedupe-key reproduction is _nearly_ but not exactly byte-identical, so it
   cannot be the merge's only safeguard.** `getHistorySearchDocumentDedupeKey`
   derives `matchSnippet` from the first match position, so an uncapped rescan
   does reproduce the indexed key for almost any match already inside the first
   2000 chars — but not all of them. `extractSnippet` ends the snippet at
   `min(text.length, index + query.length + 60)` and appends `…` only when that
   end is short of the text's end. For a first match at index `i` where
   `i + query.length + 60 > 2000`, the capped document's snippet stops at 2000
   with no trailing ellipsis while the uncapped one runs 60 chars further and
   gains one — different snippet, different key, one duplicate row. That is a
   ~60-character-wide window per candidate, rare but entirely real on a corpus
   this size. See the emission rule in "Implementation design" below, which
   removes the case rather than papering over it. (The near-miss is also
   precisely why option A would double-count outright: its windows produce
   different snippets for the same event.)

## Implementation design (settled)

Read against the code as it stands: `HistorySearchIndexService.scanForMatches`
(recency-ordered, abortable, group-buffered, cursor-resumable),
`HistorySearchShardScanner`, `historySearchRebuildWorker`,
`HistoryCandidateExtractor`, `TimelineRecorder.streamEvents` /
`streamEventsForHistorySearch`, and `WebviewMessageRouter`'s SEARCH_HISTORY
handler.

1. **The deep pass is interleaved per run inside the existing scan, not run as
   a second pass afterwards.** `scanForMatches` already visits shards (one
   shard = one run) in descending `startedAt`, buffers each `startedAt` group,
   dedupes it, checks the page target only at group boundaries, and can stop
   early, resume from a cursor, and abort between shards and lines. A deep
   query keeps all of that: for each shard it visits, after considering the
   shard's indexed documents it also streams that run's `events.jsonl`
   uncapped and considers the extra documents **into the same group buffer**.
   Ordering, dedupe, early termination, incremental `onPartialResultsFound`
   pushes, `atLeast` counts, cursor resumption and cancellation rollback are
   then inherited unchanged rather than reimplemented — which is the whole
   reason the responsive-query plan's machinery is worth reusing. A separate
   "scan the index, then scan the disk" pass would produce two recency-ordered
   lists concatenated, which is not one flat list.

2. **A deep pass emits only matches the capped prefix misses.** For each
   uncapped candidate, if `text.slice(0, MAX_INDEXED_TEXT_LENGTH)` already
   contains the query, the indexed pass has already reported that event —
   discard it. Only a candidate whose match exists solely past the cap becomes
   a deep result. This is what preserves one result per matching event (the
   drawer's stated model), and it removes the snippet-boundary duplicate
   described above by construction instead of relying on key equality. The
   shared `seenDedupeKeys` set still runs over deep results as a backstop.

3. **The per-run over-cap signal goes in the manifest, and the index schema
   version does _not_ change.** Add an optional `overCapCandidateCount` to
   `HistorySearchIndexManifest.indexedRuns[*]`. Bumping `INDEX_SCHEMA_VERSION`
   from 4.2.0 would force every existing index to be discarded and fully
   rebuilt (2.29 GB and minutes of worker time on the measured history) to gain
   a field that only lets the deep pass skip the 17% of runs with nothing
   hidden. Instead the field is optional and **`undefined` means "unknown —
   must be deep-scanned"**, so behaviour is correct on a pre-existing index
   from the first query and the counts fill in as runs are re-indexed. Only
   `overCapCandidateCount === 0` licenses skipping a run's uncapped rescan.

4. **The count is collected where truncation actually happens.** Candidates
   reach `HistoryCandidateExtractor` already shortened:
   `TimelineRecorder.streamEventsForHistorySearch` truncates each event's
   strings via `truncateHistorySearchEvent` before the extractor ever sees
   them, so the extractor cannot tell an over-cap candidate from an exactly-
   sized one. Thread an optional truncation callback/counter through
   `streamEventsForHistorySearch` and accumulate per run in the rebuild worker
   (both the full and the incremental path). Semantics are "how many source
   strings were shortened for this run" — a has-hidden-text signal with a
   useful magnitude, not an exact candidate count, and it is only ever read as
   `> 0` / `=== 0` / unknown.

5. **Shard entries must carry their run's source paths.**
   `HistorySearchShardEntry` is `{shardName, startedAt}` today; the deep pass
   needs the run's `manifestPath` (and thus its `events.jsonl`) plus the
   over-cap count to act on. `resolveShardVisitEntries` already walks
   `indexedRuns` to resolve `startedAt`, so carry the entry's `manifestPath`
   and `overCapCandidateCount` through at the same time — no extra I/O. A
   shard with no manifest entry (in-flight write, unloadable manifest) has no
   run source and is simply not deep-scanned; it is still scanned normally.

6. **Memory rules for the uncapped path.** One event, and one candidate, in
   flight at a time — never an array of a run's uncapped documents. Do not
   materialize `textLower` for a deep candidate (match with a lowercased
   `indexOf` on the raw text; the persisted key exists to speed up a JSONL
   prefilter that does not apply here), and retain nothing beyond the projected
   `HistorySearchResult`'s bounded snippet. The cap on _stored_ text is
   unchanged; nothing new is written to the index.

7. **`deep` is part of the listing identity, not just a flag.** Add
   `deep?: boolean` to `HistorySearchQuery` and `SearchHistoryMessage`, and
   include it in **both** `HistorySearchIndexService.getSnapshotKey` and
   `WebviewMessageRouter`'s `getHistorySearchListingKey`. Miss the former and a
   deep query is answered from the shallow query's cached snapshot; miss the
   latter and toggling deep either fails to supersede the in-flight shallow
   scan or, worse, deep paging requests cancel each other.

8. **The disk-scan fallback stays capped.** `HistorySearchService.searchLegacy`
   runs only when the index path already failed, often under memory pressure;
   it keeps `MAX_INDEXED_TEXT_LENGTH` and ignores `deep`. Deep search is an
   index-path capability, and the response's existing `indexState: "fallback"`
   already tells the UI the answer came from elsewhere.

9. **Surface: a query-level toggle in the drawer's sticky header**, beside the
   result summary — not a per-result badge (83.3% of runs would carry one) and
   not a per-run "matched nothing" prompt (the 85-vs-200 case proves a run can
   hold both indexed and hidden matches for the same query). Toggling it
   re-issues the current query as a new listing. The existing one-result-per-
   event sentence stays true and unchanged, per rule 2.

## Implementation steps

Ordered so each builds only on landed work:

1. Extract the shared run-document builder (DRY; no behaviour change).
2. Record the per-run over-cap signal in the manifest and carry it, with the
   run's source paths, on `HistorySearchShardEntry`.
3. Build the uncapped single-run deep scanner module.
4. Interleave it into `HistorySearchIndexService`'s scan and plumb `deep`
   through the query contract.
5. Add the drawer's deep-search toggle and its message/router/store plumbing.
6. Close out the docs (move this plan to `dev/implemented/`, update
   `orchestration.instructions.md`) and run the full gate.

## Non-goals

- **No unbounded per-document text.** Whatever ships here keeps a hard cap
  per stored document; the point is more documents when needed, not bigger
  ones.
- **No change to `MAX_INDEXED_TEXT_LENGTH` itself.** The cap number is not
  the problem; the single-window-per-candidate model is.
- **No change to the document-vs-occurrence result-counting semantics.**
  That's a separate, working-as-intended difference from `OutputFindBar` and
  out of scope here — but note this is now a constraint rather than merely a
  non-goal: option A would change those semantics as a side effect, which is
  the conflict described under "Sequencing". Option B keeps them, so the
  drawer's copy needs no change.
- **No growth in the persisted index.** This is now a hard constraint rather
  than a preference: the chosen option adds no documents and no bytes, and any
  implementation drift back toward storing more per run reopens the 2.66x /
  −42%-cache costs the decision rejected.

## Acceptance criteria (option B)

- [x] A measurement spike against a large real workspace (not just the one run
      in this doc) quantifies how many documents are actually affected today,
      to size the true blast radius before committing to an option, against a
      schema 4.2.0 index, reporting added documents, on-disk growth
      (remembering `textLower` doubles each document's text), and the change in
      how many runs fit in the `historySearchCacheMb` budget. Done by
      `scripts/spike-history-search-truncation.mjs`; see "Measurement spike"
      above. (`scripts/bench-history-search-document-cache.mjs` remains the
      harness for measuring the cache against a _live_ index during option-B
      validation.)
- [x] A term appearing only in the interior of a long response/diff/tool output
      is reachable from the drawer without the user knowing which run it is in
      — i.e. the deep search is reachable from the query, not only from a
      result row (see "What the spike changes about option B", point 3).
- [x] Per-document stored text size never exceeds `MAX_INDEXED_TEXT_LENGTH`,
      and the persisted index gains no documents and no per-document fields.
- [x] The per-run over-cap signal is recorded in the index manifest's
      `indexedRuns` entry and is usable without reading any shard.
- [x] Adding that signal does not invalidate existing indexes: `INDEX_SCHEMA_VERSION`
      is unchanged and a run with no recorded count is treated as unknown (so it
      is deep-scanned), never as "nothing hidden".
- [x] A deep result is only ever produced for a match the capped prefix misses,
      so no event yields both an indexed and a deep row.
- [x] A deep search is abortable and reports incrementally on the same terms as
      the indexed scan (`HistorySearchCancelledError`, `atLeast` counts,
      supersession keyed on the listing), and a cancelled one leaves no
      side effect — the `seenDedupeKeys` sharp edge in
      `.github/instructions/orchestration.instructions.md`'s
      `<searchAndRecovery>` applies unchanged.
- [x] The drawer's one-result-per-event copy is still true after the change.
      B preserves it; this criterion exists so a later drift toward windowing
      does not silently falsify it.
- [x] Tests cover the deep-search trigger and scoped scan, a run that has both
      indexed and past-the-cap matches for the same query (the 85-vs-200 shape
      that produced this plan — the case a matched-nothing trigger would miss),
      and that merging deep results with indexed ones produces no duplicate
      rows.
