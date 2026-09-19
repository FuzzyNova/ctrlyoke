# History Search Truncated-Text Match Plan

**Status:** Backlog — not started
**Priority:** P2
**Related:** `dev/implemented/HISTORY_SEARCH_PERFORMANCE_PLAN.md` (introduced
`MAX_INDEXED_TEXT_LENGTH` as an OOM guard — background for why this cap exists
at all). `dev/implemented/HISTORY_SEARCH_INDEX_RESIDENCY_PLAN.md` (the
completed resident-memory work that changes the sequencing of this plan — see
"Sequencing" below).

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

## Sequencing: the residency plan has landed

`dev/implemented/HISTORY_SEARCH_INDEX_RESIDENCY_PLAN.md` replaced the
extension-host's resident-document map with streamed shard queries. Option A
above (windowing) therefore no longer increases permanently resident heap —
the additional documents are read from disk as part of the same streamed pass.
The remaining costs are the on-disk index growth and the window/dedupe design
described above; measure those before shipping, but residency is no longer the
reason to block this plan. Option B still avoids index growth, and Option C
still has bounded growth (at most 2x for affected candidates).

## Recommendation

Re-evaluate A now that the residency work has landed: it is the complete
coverage option without the former permanent-residency penalty, subject to a
measurement of index growth and the overlap/dedupe behavior. C remains a
small, bounded improvement if a lower-risk partial fix is preferred, while B
still requires the new UI and per-run fallback path described above.

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
