# Output Scroll Jitter Correction Pass

**Status**: ✅ IMPLEMENTED (August 2026) — called "good enough" at commit `070846d3`;
follow-up cleanup and both deferred items landed the same day (see "Follow-Up" below)
**Scope**: `src/ui/webview-react/` output pane virtualization, scroll anchoring, and row estimation
**Workflow**: `load-and-scroll-bugs-2026-08-12T19-48-19-095`, 16 steps over ~14 hours

---

## The Symptom

Scrolling the output pane of a large workflow (6,000+ rows) was smooth _during_ the
scroll and broke _after_ it. The user would stop at position A, the view would jump
to position B, then jump back to A. Two variants appeared over the pass:

- **A → B → A** — a visible round trip, initially ~40px over hundreds of milliseconds,
  later compressing to a 1-2 frame flash of ~20px.
- **A → B (stays)** — a jump that never returned, which appeared _after_ the first few
  fixes and was a distinct bug, not a regression of the same one.

It was worse on the phone (narrow browser client) than in the desktop panel, which
turned out to be a consequence of pane width and commit latency rather than of the
extension↔browser round trip.

---

## Root Causes Found

The pass found **six** independent causes. Each was real, each was fixed, and none of
them alone accounted for the symptom — which is why it took so many rounds.

### 1. Two actors owned `scrollTop` on different clocks

The largest single cause. TanStack's `shouldAdjustScrollPositionOnItemSizeChange`
compensates a row's size change by writing `scrollTop += delta` from the
**ResizeObserver** — while every row is still painted at its pre-commit
`translateY`. Rows are absolutely positioned, so a row growing does not displace its
siblings until React commits the new `start` values. The anchor lock in
`useOutputScrollTarget` then undoes that write once the commit lands, 450-650ms later
on a phone.

That round trip _is_ the A → B → A bug. Tuning _when_ the virtualizer compensates only
changed which measurements triggered it.

### 2. The lock re-anchored on its own corrections

`isProgrammaticScroll` was a flag raised around each write and lowered on the next
animation frame. The lock writes in **bursts**, so an early frame lowered the flag
before the browser dispatched a coalesced (often late) scroll event. Whatever escaped
looked exactly like a user scroll, and `handleScroll` re-anchored on it — promoting a
correction the lock had made into the pane's new resting place. That is the A → B
(stays) variant.

### 3. Row height estimates were fitted constants, not geometry

`estimateDiffStructuredEventHeight` and friends carried calibrated numbers: a
`max(18, (fs - 1) * 1.55)` line height (18.6 against a real 18px grid), 168/224px of
horizontal chrome, and a 24px inter-column gap that a `table-layout: fixed` table does
not have. Every wrap-bound diff estimate ran 15-20% long.

### 4. Pane width was measured after paint

A diff row bakes its whole render plan into the row object at `buildOutputRows` time.
An unmeasured pane resolves to `DEFAULT_OUTPUT_CONTENT_WIDTH` (760) — roughly double a
phone's — so measuring in a plain `useEffect` let the virtualizer measure and cache
760-sized rows before the real width ever landed. That produced 78-167% under-estimates
sitting beside well-behaved 15% ones in the same pane.

### 5. `estimateSize` was not O(1)

TanStack rebuilds its entire measurements array whenever any single row reports a size,
calling `estimateSize` for every index from the lowest changed one to `count`. On a
6,000-row workflow one measured row costs thousands of estimates, at least once per
commit — and `estimateOutputRowHeight` was re-sanitizing a Bash row's full output to
size a few-hundred-character preview each time.

### 6. The correction landed one paint after the reflow

The last one, and the source of the final residual ~20px flash. Once the anchor lock
was the sole writer, its correction still had to _batch into the same commit_ as the
reflow it was correcting. `scheduleMeasurementVersionBump` deferred the layout-version
bump to a `requestAnimationFrame`, so the reflow painted first and the correction
followed a frame later.

---

## What Shipped

| Commit     | Cause | Change                                                                                                                                                                                                                                                                                                                                        |
| ---------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `9dc6b43c` | —     | Discard duplicate panel READY messages (fixed the separate output load/unload flashing reported in step 0)                                                                                                                                                                                                                                    |
| `6bae9270` | 1     | First attempt: suppress above-anchor compensation instead of the viewport jump                                                                                                                                                                                                                                                                |
| `1a41d13e` | 1     | Guard compensation against unobserved direct `scrollTop` writes                                                                                                                                                                                                                                                                               |
| `e8bc950b` | 5     | Memoize row height estimates per row object; `buildOutputRows` publishes rows already warm                                                                                                                                                                                                                                                    |
| `cb7f3850` | 1, 2  | **`shouldAdjustScrollPositionOnItemSizeChange` returns unconditional `false`** — the anchor lock becomes the single owner of `scrollTop`. Adds `isProgrammaticScrollEcho` for position-based attribution and apply-log diagnostics (`offsetDriftPx`, `observedOffsetPx`, `anchorMovedSinceLastApply`, `scrollTopHonored`, `msSinceLastApply`) |
| `a2874be5` | 2, 6  | `classifyOutputScrollEvent` — classify _every_ scroll event before dropping any, so settle windows stop being invisible in the log. Adds `shouldSyncMeasurementCorrection`                                                                                                                                                                    |
| `17ace0f1` | 3, 4  | `diffLineHeight` / `diffCharWidth` / `diffHorizontalChrome` derived from the diff table's own CSS; width measurement moved to `useLayoutEffect`                                                                                                                                                                                               |
| `070846d3` | 6     | Removes the 24px magnitude threshold from `shouldSyncMeasurementCorrection`, making it purely ordinal. Also stabilizes the width `useLayoutEffect`'s dependencies (see below)                                                                                                                                                                 |

### One self-inflicted regression worth remembering

Moving the width measurement to `useLayoutEffect` in `17ace0f1` **doubled** the panel's
commit load (3.1 → 7.4 expensive commits/min, 1.5s → 3.3s of commit time per minute).
The effect's dependency array contained `applyScrollTarget` (identity changes every
measurement round) and `outputContentWidth` (which the effect itself sets), so it tore
down and re-created its ResizeObserver on nearly every commit. As a plain `useEffect`
that was merely wasteful; as a _layout_ effect it forced a synchronous
`getBoundingClientRect()` against a million-pixel scroll canvas inside the commit phase.

Fixed in `070846d3` by routing both through refs. **The lesson generalizes: moving work
into the commit phase requires its triggers to be stable first.**

---

## Why This Mostly Fixes It

Three things had to be true at once, and now are:

1. **One writer.** Only the anchor lock writes `scrollTop`. It resolves from the anchor
   row's own `getBoundingClientRect()` in a layout effect — closed-loop against the
   committed DOM, pre-paint — so it cannot overshoot.
2. **Its writes are attributed back by position, not timing.** A position match survives
   any number of dropped frames, so no correction can be mistaken for a user scroll and
   adopted as the new resting place.
3. **Its corrections batch into the same commit as the reflow.** Every above-anchor
   resize now bumps `measurementVersion` synchronously, so the corrective apply lands in
   the same paint as the displacement it cancels. The user sees neither.

### Measured

From the two profiler sessions either side of the final change
(`ctrlyoke-1786595458685.log` → `ctrlyoke-1786628379977.log`, panel client):

|                                                                | before  | after    |
| -------------------------------------------------------------- | ------- | -------- |
| escaped programmatic echoes                                    | 0       | 0        |
| self-induced applies (anchor didn't move but we scrolled ≥5px) | 3 of 82 | 5 of 144 |
| sub-24px share of settled corrections                          | 30%     | 22%      |
| applies per 100k px scrolled                                   | 39.5    | **6.4**  |

Earlier in the pass the estimator work (`17ace0f1`) closed the large-error class
outright:

|             | phone (unified diffs) |           | panel (split diffs) |           |
| ----------- | --------------------- | --------- | ------------------- | --------- |
|             | before                | after     | before              | after     |
| worst error | 2147px                | **173px** | 2177px              | **110px** |
| avg delta   | 84px                  | **16px**  | 14px                | **3px**   |
| scaleFactor | 1.08                  | **1.02**  | 1.02                | **1.00**  |

**Caveat on the final comparison.** The two sessions are not comparable on absolute
commit cost — the "after" session scrolled 4.9M px against the "before" session's 463k,
roughly 10×, over different content. Normalized by scroll distance every metric
improved; normalized per settle event, commit cost roughly doubled. Neither normalizer
is trustworthy across such different sessions. **If commit cost is ever the question,
measure it in a controlled session rather than trusting this pair.**

---

## Known Limits (deliberately not fixed)

All three items below were closed in the same-day follow-up — see "Follow-Up: Log
Cleanup and Deferred Items" — but the original reasoning is kept here since it explains
_why_ each fix takes the shape it does.

- ~~**`Decoration` gap rows are not counted.**~~ Fixed. Each collapsed region in a diff
  renders one row that `estimateRenderedVisualRows` did not model. It pushed estimates
  _up_, and the bias at the time was already up, so landing it alongside the chrome
  correction would have made the next log unattributable — it was safe to land only
  once the other estimator fixes had stabilized.
- ~~**Expanding a diff gap is not viewport-pinned.**~~ Fixed. `handleExpand` in
  `DiffView.tsx` updated expansion state and nothing else. The expansion inserts lines
  _above_ the button, so one "Show 25 of N" click shifted the view by ~450px on a phone.
  The anchor lock could not help: on a diff taller than the viewport the committed
  anchor is the diff row's _top_, and holding that stationary is precisely wrong when
  the change is inside the row.
- ~~**`applyScrollTarget` mutes itself for 200ms after any user scroll**~~ Improved, not
  eliminated. `hasRecentUserScrollInput` still mutes corrections for
  `userScrollInputGraceMs` after the most recent real scroll signal, and that tradeoff
  (never fight an active user gesture) is intentional and unchanged. What was fixed is
  the repair's own timing: it used to reschedule a full grace window from _whenever the
  muted attempt happened_, so a reflow landing late in the window could wait up to 2x
  the grace period. It now targets the window's real expiry, capping the uncorrected
  paint at one grace period.

---

## Next Steps

### 1. Trim the profiler logging (do this first — it is cheap)

The diagnostics added in `cb7f3850` and `a2874be5` did their job and are now the bulk of
the log. In `ctrlyoke-1786628379977.log`: **6,202 of 6,712 lines (92%) are `[FP-perf]`
lines, 1.79 MB for 27 minutes.** `scrollAttribution` alone is 4,248 of them (68%) — one
line per scroll event, by design, because settle windows used to be invisible.

Profiling is opt-in (`localStorage["ctrlyoke.profiler.enabled"]` + `window.ctrlyokeProfiler`),
so this costs nothing when off. It is a legibility problem, not a performance one.

Suggested:

- Gate `scrollAttribution` behind its own flag, defaulting off, or emit only
  non-`user-scroll` verdicts plus a periodic rollup. The per-event stream was needed to
  find causes 1 and 2; it is not needed to confirm they stay fixed.
- Drop the `App` profiler wrapper. It tracked `OutputVirtualRows` almost exactly in the
  final log (p50 304ms vs 306ms, max 1235ms vs 1156ms) and carries 120 events to say so.
- Keep `scrollTarget` applies, `rowEstimateOutlier`, `rowEstimateStats`, and
  `reactCommit`. Those four are what every diagnosis in this pass was actually built on.

### 2. Optionally land the two deferred items above

The gap-expansion pin is the more user-visible of the two.

---

## Follow-Up: Log Cleanup and Deferred Items

Landed the same day as the "good enough" call, closing every item in "Next Steps"
above (all three "Known Limits" items, treating the "two deferred" phrasing loosely).

- **Log cleanup.** `scrollAttribution`'s routine `user-scroll` verdict is now gated
  behind its own opt-in profiler flag (`logScrollAttribution`, default off, toggle in
  Developer Settings); the settle-window verdicts that actually diagnose a stuck pane
  (`suppressed-layout-work`, `programmatic-flag`, `measurement-flush`,
  `programmatic-echo`) still log unconditionally while profiling is on, since they were
  never the volume problem. The redundant `App` `<Profiler>` wrapper in
  `BootstrapApp.tsx` was removed — `OutputVirtualRows`' own profiler already tracked it
  almost exactly.
- **Gap-expansion viewport pin.** `resolveDiffGapExpansionScrollTarget`
  (`utils/outputAutoscroll.ts`) re-points the anchor lock's committed `viewportOffsetPx`
  by the diff row's measured height delta _before_ the lock's own layout effect
  resolves, so the lock itself performs the compensating `scrollTop` write on its next
  resolve — no second writer touches `scrollTop`, preserving the pass's core invariant.
  Wired in `OutputSection.tsx` as a `useLayoutEffect` registered _before_ the
  `useOutputScrollTarget()` call, so React runs it first within the same commit.
- **Decoration gap rows counted.** `diffGapDecorationHeight` (`outputLineMetrics.ts`)
  and `countCollapsedDiffGaps` (`rdvAdapter.ts`) add each still-collapsed gap bar's
  height into `DiffRenderPlan.bodyHeight`, exposed as `gapDecorationRows` /
  `gapDecorationsHeight` for callers that want the breakdown.
- **200ms mute-window latency capped.** `resolveDeferredScrollTargetApplyDelayMs`
  schedules the deferred repair against the mute window's real expiry (based on the
  triggering scroll signal) instead of a fresh grace period from the muted attempt
  itself, capping worst-case uncorrected-paint time at one grace period instead of up
  to two. The mute decision itself (`hasRecentUserScrollInput`) is unchanged.

All four changes are covered by unit tests (`test/utils/outputAutoscroll.test.ts`,
`test/utils/rdvAdapter.test.ts`, `test/utils/outputLineMetrics.test.ts`,
`test/hooks/useOutputScrollTarget.test.ts`) and the full suite (2752 extension +
1697 UI tests) was green after landing.

---

## The Next Real Project: Output Commit Cost

This is the remaining ceiling. It is a bigger project than anything in this pass, and it
is worth stating precisely because a wrong framing of it nearly got recorded here.

### Correction to an earlier claim

An earlier turn asserted that commits were "200-545ms for ≤12 rendered rows, **every one
of them a `nested-update`**, which says something sets state during commit and forces a
second pass." **The `nested-update` half of that is wrong** — it generalized from the
first sampled event. The actual split is 12 `nested-update` of 90 commits after
(13%), and 3 of 23 before (13%): unchanged, and a minority either way. There is no
commit-phase-setState pathology to hunt.

The cost is real; the diagnosis below replaces it.

### What the data actually says

From `ctrlyoke-1786628379977.log`, panel client, 90 commits ≥200ms over 27 minutes,
`totalRows` = 6,115 throughout:

| metric                          | value                                        |
| ------------------------------- | -------------------------------------------- |
| `actualDuration`                | p50 **306ms**, p90 **653ms**, max **1156ms** |
| `baseDuration`                  | p50 504ms                                    |
| `actualDuration / baseDuration` | p50 **92%**                                  |
| `virtualRows`                   | p50 13, max 23                               |

Two facts point the same direction:

**Cost is flat in `virtualRows`.** A commit rendering _one_ virtual row averaged 249ms;
13 rows averaged 415ms; 23 rows averaged 318ms. Rendering more rows barely costs more,
which means the dominant work is not per-rendered-row.

**Memoization is buying ~8%.** `actualDuration` sits at 92% of `baseDuration` — React is
re-rendering essentially everything it would render from scratch.

Together: **the cost is O(`totalRows`), not O(`virtualRows`)**, and it is paid on every
measurement round.

### Where to look

Two known O(`totalRows`) sweeps run per `measurementVersion` change:

1. **`rowLayout` in `useOutputVirtualization.ts`.** Its `useMemo` lists
   `measurementVersion` as a dependency and, in the virtualized branch, makes four full
   sweeps over ~6,115 entries — `measurementsCache.filter()`, `.map()`, the
   `measurementsByKey` `Map` construction, then the `rows.entries()` loop — allocating
   four fresh collections (`measurementsByKey`, `rowStartsByIndex`, `rowStartsByKey`,
   `rowSizesByKey`) each time.
2. **TanStack's own `estimateSize` rebuild**, which re-runs for every index from the
   lowest changed one to `count`. Already documented in
   `webview-react-hooks.instructions.md`; `estimateOutputRowHeight` was made O(1) in
   `e8bc950b`, but O(1) × 6,115 × several rounds per commit is still the shape of the
   problem.

**Note the interaction with this pass.** Removing the sync threshold in `070846d3` made
`measurementVersion` bump on _every_ above-anchor resize rather than only those ≥24px —
which is exactly what drives `rowLayout` recomputation. The pass traded a visible flash
for more of this work. That is the right trade at today's cost and the wrong one if the
cost grows, which is the main reason this project is next.

### What the project entails

1. **Confirm the diagnosis before optimizing.** Add a temporary timer around the
   `rowLayout` memo body and one around a full `estimateSize` sweep. If they do not
   account for most of a 300ms commit, stop and re-diagnose — everything above is
   inference from shape, not direct measurement.
2. **Make `rowLayout` incremental.** It rebuilds four whole collections to reflect a
   change of one row's height. A prefix-sum structure updated from the first changed
   index — or dropping `rowStartsByKey`/`rowSizesByKey` in favor of querying the
   virtualizer's own `measurementsCache` at the two or three call sites that need them —
   turns O(n) per round into O(changed).
3. **Reconsider whether `measurementVersion` must be a React state value at all.** Its
   only real job is to re-trigger the anchor lock's layout effect. Everything else that
   consumes it pays a full re-render for a number that changes several times per second.
4. **Then re-measure the same four events** (`scrollTarget` applies, `rowEstimateOutlier`,
   `rowEstimateStats`, `reactCommit`) in a _controlled_ session — same content, same
   scroll distance — since the sessions in this pass are not comparable on cost.

Only after that is it worth asking whether the anchor lock can be made invisible under
load, because a reflow landing inside a 300ms commit is visibly wrong for 300ms no
matter how correct the lock is.

---

## Durable Knowledge Recorded

Three constraints from this pass live in the instruction files, because each reads like
a style choice and will otherwise be "simplified" back:

- `webview-react-hooks.instructions.md` — the anchor lock is the sole owner of
  `scrollTop`; `shouldAdjustScrollPositionOnItemSizeChange` returns `false` on purpose;
  attribution is by position, never by a flag; `shouldSyncMeasurementCorrection` must
  stay **purely ordinal** (a magnitude threshold does not filter noise, it _sets the
  flash amplitude_, and it saves no render because TanStack's own `notify()` re-renders
  in the same synchronous stack).
- `webview-react-hooks.instructions.md` — `estimateSize` must stay O(1) per row.
- `webview-react.instructions.md` — a diff row's height is baked in at `buildOutputRows`
  time, so `outputContentWidth` must already be measured when rows are first built;
  hence the load-bearing `useLayoutEffect` in `OutputSection`.
