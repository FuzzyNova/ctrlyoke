# History Search Background Scan Plan

**Status:** Backlog — not started
**Priority:** P2
**Predecessor:** `dev/implemented/HISTORY_SEARCH_RESPONSIVE_QUERY_PLAN.md`
(option A: the recency-ordered scan with early termination, which is what
makes a result count provisional in the first place). The two bugs its
early-termination design shipped with — per-client search supersession and a
cancelled scan poisoning the retained dedupe set — are **fixed**; see
`.github/instructions/orchestration.instructions.md`. This doc is about the
remaining behaviour, which is working as designed and still unsatisfying.

> **2026-10-10 audit:** Still not started — no scan session, no
> `STOP_HISTORY_SEARCH`, and no interim "count all results" control. Every cited
> symbol was verified against the current code (`HistorySearchIndexService`
> `scanForMatches`/`getSnapshotKey`/`HistorySearchScanCursor`, router
> `routeQueue`/`beginHistorySearch`/`getHistorySearchListingKey`,
> `HISTORY_SEARCH_DEBOUNCE_MS = 600` in `HistorySearchDrawer.tsx`,
> `historySearchCacheMb` default 320). One correction: partial results are applied in
> `hooks/useMessageHandler.ts`, which updates the `uiStore` search state.

## The problem in one sentence

A scan stops the moment the requested page is full, so a query's result count
is a lower bound (`countState: "atLeast"`, rendered as `73+`) that only grows
when the user scrolls — and a user who stays on the first page has no way to
learn the real total, or to tell a genuinely small result set from a scan that
simply stopped early.

## Why this reads as a bug even though it is the design

Reported from live use on the real 1,560-run workspace:

> the number of results stays constant at ~50+ and even when I scroll all the
> way down the total number I end up with is smaller than what it used to be

The second half of that was the dedupe-set corruption, and is fixed. The first
half is this plan. The `+` suffix is doing real work in the UI, but a count
that never moves while a spinner turns next to it reads as a stalled search
rather than as a deliberate lower bound.

## What the user asked for

> having an "X" or "stop search" button by the results spinning indicator but
> still always keep searching/updating results in the background, so if I stay
> on the first page, the count continues to climb, but clicking a result or
> the stop button would stop the search

That is the right shape. The machinery for the _pushing_ half already exists:
`HistorySearchIndexService.scanForMatches` takes `onPartialResultsFound`, and
the router relays it as `SEARCH_HISTORY_PARTIAL_RESULTS`, which
`useMessageHandler` applies to the `uiStore` search state exactly like a page
response. What is missing is a scan that keeps
running when no page request is waiting on it.

## The blocker: `routeQueue`

**Every webview message funnels through one `routeQueue` promise chain per
`WebviewMessageRouter`.** A search handler that keeps scanning holds that
chain, so run-view loads, settings writes, and workflow mutations all wait
behind it. This is not a theoretical concern — it is precisely why the
predecessor plan's option D (cancel superseded searches) had to abort
_synchronously in `route()`_, before the new message could even be enqueued.

Today that is tolerable because a scan is bounded by "fill one page", which is
3.8–15.5 ms for a recent-term query. A background continuation is bounded by
the index instead: ~10 s for a full pass on this workspace, ~12 s for a query
with no matches. Paying that on every search — including the ones that were
satisfied in 5 ms — would be a large regression in dashboard responsiveness
that has nothing to do with search.

So the background scan **must run detached from `routeQueue`**, and that is
the whole difficulty of this plan.

## The hazard that detaching creates

Once a scan can run without a request awaiting it, two scans can touch one
listing's state at once: the background continuation and a page request the
user's scrolling just issued. Today `routeQueue` is the only thing preventing
that, and the state involved is not safe to share:

- `HistorySearchMatchSnapshot.results` — the ordered, deduped prefix. Two
  writers append the same runs' matches twice.
- `HistorySearchScanCursor.nextShardIndex` — one writer's progress silently
  becomes the other's starting point.
- `HistorySearchScanCursor.seenDedupeKeys` — shared **by reference** on
  purpose (copying it would cost O(matches so far) per page). Concurrent
  mutation here is exactly the failure mode that already shipped once as a
  cancellation bug: a key admitted by one scan suppresses the other's
  legitimate match, and the document is then missing from every page of that
  listing for the rest of its life. It produces no error and no log line — the
  only symptom is a final `exact` count below the truth.

Any design here has to make concurrent scanning of one listing impossible, not
merely unlikely.

## Sketch

A per-listing **scan session** owned by `HistorySearchIndexService`, keyed the
same way snapshots are (`getSnapshotKey`):

- The session owns the cursor, the dedupe set, and the accumulated results.
  Exactly one scan loop per session runs at a time; nothing else advances the
  cursor.
- A page request does not start a scan. It registers a target count with the
  session and awaits the point where `results.length >= targetCount` (or the
  scan completes). If no loop is running, it starts one.
- The background continuation is the same loop with no target: it runs to the
  end of the index unless stopped. A page request arriving mid-flight is
  satisfied by the loop already running rather than starting a second one —
  which is also strictly less work than today, where each page resumes the
  scan itself.
- Each finalized `startedAt` group pushes `SEARCH_HISTORY_PARTIAL_RESULTS` as
  it does now, so the count climbs live with no new message type.
- Stopping is a new `STOP_HISTORY_SEARCH` message plus the existing implicit
  triggers: a new listing (already aborts, see `beginHistorySearch`), closing
  the drawer, and navigating to a result.

The router's SEARCH_HISTORY handler returns as soon as its page is satisfied,
so `routeQueue` is held only for the page — the continuation outlives the
handler and belongs to the session, not to the message.

## What must not break

- **The no-concurrent-scan invariant above.** It is the whole reason this is a
  plan and not a patch.
- **Supersession stays listing-scoped.** Page requests for one listing are
  additive and each owes the webview a response; only a different query or
  filter set may abort. See `getHistorySearchListingKey`.
- **A cancelled scan still rolls back its dedupe-set admissions.** A
  background loop that is stopped mid-group is a cancellation like any other.
- **Sort order and dedupe semantics**, unchanged: matches are only finalized
  at a `startedAt` group boundary, because a row's deduped ordinal depends on
  everything ahead of it.
- **`countState`'s meaning.** A background scan that reaches the end of the
  index produces `"exact"`; one that is stopped early stays `"atLeast"`.
  Stopping must not be allowed to report a lower bound as a real total.

## Non-goals

- **Not a return to scanning eagerly on every keystroke.** The debounce
  (`HISTORY_SEARCH_DEBOUNCE_MS`, currently 600 ms) and listing-scoped
  supersession stay; a background scan is started by a settled query, not by
  typing.
- **Not the trigram postings sidecar** (option E in the predecessor plan).
  That is the answer to a no-match query still costing a full ~12 s pass;
  background scanning only moves that cost off the critical path, it does not
  remove it. If the tail still hurts after this, that plan is next.
- **Not a change to the document cache budget.** `historySearchCacheMb`'s
  default of 320 MB was measured, and a background scan does not change what a
  scan retains — see the predecessor plan's re-tuning section before assuming
  a larger budget would help here.

## Interim option, if this stays unscheduled

A "count all results" control beside the summary label: one `SEARCH_HISTORY`
for a far offset, which forces the scan to completion and turns `1,827+` into
`1,827`. It needs no new machinery — it is an ordinary page request, on
`routeQueue`, cancellable by the existing supersession — and it resolves the
"am I missing results?" question without changing the default behaviour. It
does not stream the count, and it does hold `routeQueue` for the duration of
the pass, which is why it is an interim measure rather than the design.

## Acceptance criteria

- [ ] A settled query's result count climbs on its own, with no scrolling,
      until it is exact or stopped.
- [ ] A dashboard interaction (run-view load, settings write, workflow
      mutation) issued during a background scan is not delayed by it.
- [ ] One listing is never scanned by two loops at once, covered by a test
      that interleaves a page request with a running background scan and
      asserts the result set is identical to an uninterrupted full scan.
- [ ] A stopped scan reports `countState: "atLeast"`, never `"exact"`.
- [ ] Stopping happens on the stop button, on navigating to a result, on
      closing the drawer, and on a new listing.
- [ ] Result ordering and dedupe are identical to a single full scan for a
      query whose background scan ran to completion.
