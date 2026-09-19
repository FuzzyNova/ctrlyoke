# History Search Truncated-Text Match Plan

**Status:** Backlog — not started
**Priority:** P2
**Related:** `dev/implemented/HISTORY_SEARCH_PERFORMANCE_PLAN.md` (introduced
`MAX_INDEXED_TEXT_LENGTH` as an OOM guard — background for why this cap exists
at all). `dev/implemented/HISTORY_SEARCH_INDEX_RESIDENCY_PLAN.md` and
`dev/implemented/HISTORY_SEARCH_RESPONSIVE_QUERY_PLAN.md` — both landed since
this plan was written, and together they change what option A actually costs;
see "Sequencing" below, which is the section to read first.

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
2. This truncation gap — **not fixed**, is the subject of this doc.

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
edge case, so this isn't rare.

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
  truncated. Needs a measurement spike (see below) to know the real blast
  radius across a large workspace, not just the one run measured above.
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

- **Memory:** no change to the persisted index's steady-state size.
- **Coverage:** complete, but discovery is opt-in per run rather than a single
  query surfacing every match across the workspace in one pass — a real
  regression from "one search box, one flat result list" if this is the only
  fix.
- **Complexity:** lower than A. No windowing, no dedupe interaction, no
  overlap tuning.
- **User experience:** requires new UI (the "search this run directly"
  affordance) and a per-run scan path that does not currently exist.

### C. Anchor windows (first + last N chars only)

Cheaper compromise: instead of full chunking, index the first
`MAX_INDEXED_TEXT_LENGTH` chars (today's behavior, unchanged) plus a second
document for the last `MAX_INDEXED_TEXT_LENGTH` chars when the candidate
exceeds `2 * MAX_INDEXED_TEXT_LENGTH`.

- **Memory:** at most 2x today's per-candidate cost, never more, regardless of
  how long the source text is.
- **Coverage:** catches matches at the start or end of long text (openings and
  conclusions of long responses, which is where search terms often land) but
  not the middle — the 171 KB example above would still lose matches sitting
  in the interior. Strictly better than today, provably incomplete.
- **Complexity:** lowest of the three — no overlap tuning, no dedupe
  interaction beyond what already exists for multiple documents per event.

## Sequencing: both predecessor plans have landed

Two changes since this plan was written move the numbers it reasons about, in
opposite directions. Read both before picking an option.

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
   against the older numbers.
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
   after, not just index size.
3. **More documents per run means more lines scanned before the page fills.**
   The scan is recency-ordered and stops at `offset + limit`, so it reads
   whole runs at a time. Windowing does not change which runs it visits, but
   it does change how much each one costs. Bounded and probably small;
   measure it rather than assume.

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

## Recommendation

A is still the complete-coverage option and the residency objection to it is
gone, but it is no longer the obvious pick it briefly looked like: it now
carries a ~1.45x on-disk multiplier per added window, a document-cache hit-rate
regression that would show up as latency on unrelated queries, and a direct
conflict with the one-result-per-event model the drawer now states in prose.
Measure those three before committing to it.

B has gained relative standing for the same reasons — it adds no documents, so
it touches neither the cache nor the counting model — at the cost of the new
UI and per-run scan path it always required. C remains the small bounded
improvement, with a milder version of A's counting-model problem.

The measurement spike is now the gate, not a formality.

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
  the conflict described under "Sequencing".

## Acceptance criteria (for whichever option is picked)

- [ ] A term appearing only in the interior of a long response/diff/tool
      output is findable via history search (for A) or explicitly surfaced as
      "not fully indexed, search this run" (for B) or found when it lands in
      the first/last window (for C, with the interior gap documented as a
      known limitation).
- [ ] Per-document stored text size never exceeds `MAX_INDEXED_TEXT_LENGTH`.
- [ ] A measurement spike against a large real workspace (not just the one run
      in this doc) quantifies how many documents are actually affected today,
      to size the true blast radius before committing to an option. Run it
      against a schema 4.2.0 index and report three numbers, not one: added
      documents, on-disk growth (remembering `textLower` doubles each
      document's text), and the change in how many runs fit in the
      `historySearchCacheMb` budget. `scripts/bench-history-search-document-cache.mjs`
      is the existing harness for the third.
- [ ] The drawer's one-result-per-event copy is still true after the change,
      or was updated in the same commit. See "And windowing collides with the
      counting model the UI now states".
- [ ] Tests cover a query landing exactly in a window-boundary overlap region
      (A), the fallback trigger and scoped scan (B), or a query landing in the
      indexed interior gap correctly returning no match rather than a wrong
      one (C).
