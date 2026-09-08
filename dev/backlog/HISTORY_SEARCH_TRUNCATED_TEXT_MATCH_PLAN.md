# History Search Truncated-Text Match Plan

**Status:** Backlog — not started
**Priority:** P2
**Related:** `dev/implemented/HISTORY_SEARCH_PERFORMANCE_PLAN.md` (introduced
`MAX_INDEXED_TEXT_LENGTH` as an OOM guard — background for why this cap exists
at all). `dev/backlog/HISTORY_SEARCH_INDEX_RESIDENCY_PLAN.md` (the still-open
resident-memory problem this plan's options would make worse if done first —
see "Sequencing" below).

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
instructions bullet). But truncation was not a semantics difference — it was
real, measured data loss:

| Measurement (one real run, `ACCESSIBILITY_AND_TESTABILITY_PLAN`)     | Value       |
| ---------------------------------------------------------------------- | ----------- |
| Longest single candidate text (one structured event's content)         | 171,222 chars |
| Documents whose *capped* text matched the query                        | 85          |
| Documents whose *uncapped* text matched the query                      | 200         |
| Documents with a match that exists only past character 2000            | **115**     |

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
  overlap region of two adjacent windows *will* currently produce two
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

## Sequencing: this depends on the residency plan, not the other way around

`dev/backlog/HISTORY_SEARCH_INDEX_RESIDENCY_PLAN.md` documents that the
current index is fully resident in the extension host's heap
(`HistorySearchIndexService.shardDocuments`), and that this residency is
itself an open OOM risk (1.85 GB resident for one measured workspace) — not
yet fixed. Option A above (windowing) directly increases total document count
for exactly the large-candidate cases that already dominate that residency
cost. **Shipping A before the residency plan's streaming approach lands would
make an already-open OOM risk worse, not just add a new one.** Option B does
not have this problem (no index growth) and could ship independently. Option C
has a bounded, small growth (at most 2x for affected candidates) and is
probably safe either way, but should still be measured against the residency
numbers before shipping.

## Recommendation

Do not build A until the residency plan's streaming design (its Option A —
stream shards per query, hold nothing resident) lands; re-evaluate then, since
a streaming query path removes the "more documents = more permanently resident
heap" equation that makes A risky today. In the meantime, C is a small,
boundedly-safe improvement that meaningfully increases coverage (catches the
first and last window of long content, where search terms often land) without
waiting on the residency work, and is a reasonable thing to ship on its own if
the truncation gap keeps causing user-facing reports before residency is
addressed.

## Non-goals

- **No unbounded per-document text.** Whatever ships here keeps a hard cap
  per stored document; the point is more documents when needed, not bigger
  ones.
- **No change to `MAX_INDEXED_TEXT_LENGTH` itself.** The cap number is not
  the problem; the single-window-per-candidate model is.
- **No change to the document-vs-occurrence result-counting semantics.**
  That's a separate, working-as-intended difference from `OutputFindBar` and
  out of scope here.

## Acceptance criteria (for whichever option is picked)

- [ ] A term appearing only in the interior of a long response/diff/tool
      output is findable via history search (for A) or explicitly surfaced as
      "not fully indexed, search this run" (for B) or found when it lands in
      the first/last window (for C, with the interior gap documented as a
      known limitation).
- [ ] Per-document stored text size never exceeds `MAX_INDEXED_TEXT_LENGTH`.
- [ ] A measurement spike against a large real workspace (not just the one run
      in this doc) quantifies how many documents are actually affected today,
      to size the true blast radius before committing to an option.
- [ ] Tests cover a query landing exactly in a window-boundary overlap region
      (A), the fallback trigger and scoped scan (B), or a query landing in the
      indexed interior gap correctly returning no match rather than a wrong
      one (C).
