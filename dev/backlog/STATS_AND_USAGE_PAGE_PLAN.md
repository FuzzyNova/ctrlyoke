# Stats & Usage Page Plan

**Status:** Queued for implementation — plan reviewed and staged as 7 steps
(phase 1 → phase 4). Update the phase checkboxes as steps land.
**Related:** `dev/implemented/HARNESS_USAGE_TRACKING_PLAN.md`,
`dev/implemented/PROMPT_TOTAL_TOKEN_USAGE_PLAN.md`

---

## Problem

`HARNESS_USAGE_TRACKING_PLAN.md` shipped its usage cards into
`HarnessesSection.tsx`, which is rendered by `DefaultsHarnessPage.tsx` — the
**Workflow Defaults → Harness** page. That page exists to set defaults (default
harness, per-harness model, per-harness extra args). It now also carries:

- a `UsageCard` per harness (`components/settings/stats/UsageCard.tsx`)
- a "Refresh harness usage" button (`components/settings/stats/StatsUsageSection.tsx`)
- a mount-time `REQUEST_HARNESS_USAGE` postMessage (`components/settings/stats/StatsUsageSection.tsx`)

Six usage cards interleaved with six model/args editors is the wrong density for
a settings form, and it puts read-only telemetry inside a page whose every other
control writes settings. The usage data also has no home for anything
**workspace-wide** — the observed store is per-harness by construction, so
"how much have I spent in this repo, total" has nowhere to live.

## Goal

A dedicated **Stats & Usage** page in `GlobalSettingsDrawer.tsx` that answers
three questions, in this order:

1. **Where am I against my quotas right now?** (the existing per-harness cards)
2. **What has this workspace cost me overall?** (new lifetime totals)
3. **Which harness am I actually using?** (new share breakdown)

Plus a share-friendly export.

`HarnessesSection.tsx` goes back to being defaults-only.

---

## What Is Actually Worth Showing

The temptation is to show everything the data model can produce. Most of it is
noise. The filter applied below: **a number earns its place only if it changes a
decision or answers a question the user has actually asked.**

### Tier 1 — headline tiles (include)

| Tile               | Value                                                                             | Why it earns its place                                                                                                                                                                                                                            |
| ------------------ | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Workflows**      | lineage count, with run count as a secondary line                                 | The unit users think in. Lineages ≠ runs, and showing only one of them is misleading — 4 workflows / 91 runs and 91 workflows / 91 runs are very different repos.                                                                                 |
| **AI steps**       | summed `attemptCount` across runs                                                 | This is the "how many prompts have I sent" number, and it is the honest denominator for the harness share breakdown.                                                                                                                              |
| **Total tokens**   | summed `WorkflowTokenTotals.total`, `≥`-marked when any run's coverage is partial | Directly requested; already normalized upstream.                                                                                                                                                                                                  |
| **Estimated cost** | summed `costUsd` with provenance phrase                                           | Directly requested. Must reuse `formatCostLabel` / `formatCostSourcePhrase` (`src/utils/TokenFormatting.ts`) so the `≈`/`≥` and "at API list prices / not incremental subscription spend" disclaimers stay identical to every other cost surface. |
| **Time executing** | summed pause-aware active execution time                                          | Directly requested. Must be active time, not wall clock — see [Execution time](#execution-time-needs-a-durable-source).                                                                                                                           |
| **Run outcomes**   | completed / stopped / error counts                                                | Cheap (one field per manifest) and genuinely useful: a 60% error rate is a fact worth surfacing, and it contextualizes the cost tile.                                                                                                             |

### Tier 2 — harness breakdown (include)

One share visual plus a ranked row list. See [Harness share visual](#harness-share-visual).

### Tier 3 — existing per-harness usage cards (move, don't redesign)

Move `UsageCard` and the refresh button verbatim in phase 1. Redesign is a
separate concern; moving and redesigning in one change makes the diff
unreviewable.

### Explicitly out of scope (do not add)

- **Token/cost time series.** `ObservedHarnessUsageStore` prunes everything
  outside the current day/week/month (`pruneStore`, `ObservedHarnessUsageStore.ts:320-347`),
  so a trend chart would render an empty or actively misleading line for any
  window longer than a month. If trends are wanted later, they need a retained
  per-day ledger first — a separate plan, not a chart bolted onto this one.
- **Per-model breakdowns.** Model-level attribution belongs to
  `PROMPT_TOTAL_TOKEN_USAGE_PLAN.md`'s price table. Duplicating it here creates
  two answers to the same question.
- **Derived vanity metrics** (avg cost per workflow, tokens per minute,
  "efficiency" scores). They read as precise and are not.
- **Cross-workspace aggregation.** Still-open question 2 in
  `HARNESS_USAGE_TRACKING_PLAN.md` stays deferred and stays deferred here too.
  Everything on this page is workspace-local, and the page says so.

---

## Data Sources

### Current-period observed usage — already exists

`HarnessUsageSnapshot.observed` (daily/weekly/monthly per harness) already
arrives via `HARNESS_USAGE_UPDATED` and lands in `harnessUsageStore`. Reuse
unchanged.

### Lifetime totals — new store required

**The observed store cannot answer this.** It is pruned to the current
month/week by design. Lifetime totals need a sibling that is never pruned by
date.

Add `LifetimeUsageStore` in `src/core/harness/shared/usage/`, persisting to
`.ctrlyoke/.usage/lifetime-stats.json` (path helper added to `UsagePaths.ts`
alongside `observedUsagePath` / `providerSnapshotsPath` — do not build the path
ad hoc).

**Feed it from the existing hook.** `OutputHistoryManager.feedObservedHarnessUsage`
(`OutputHistoryManager.ts:1496-1519`) already fires once per terminal transition,
after the aggregate is durable in the manifest, fire-and-forget so it can never
delay a transition. Extend that method to feed both stores from the one manifest
read it already performs; rename it to `feedUsageStores`. Do not add a second
terminal-transition hook.

**Per-run contribution — an in-flight shape, never a persisted array.** The
type below is what the feed site computes for one run and what the bounded
in-memory cache holds. It is deliberately **not** persisted as a per-run list;
persisting one would reintroduce the O(runs) always-read document that rules 1–3
below exist to prevent. Read those three rules before implementing this type.

```typescript
interface LifetimeRunContribution {
  workflowKey: WorkflowKey;
  runRef: RunRef;
  updatedAt: number;
  startedAt: number;
  completedAt?: number;
  executionState: ExecutionState;
  stepCount: number;
  /** Pause-aware active execution time. Absent for backfilled pre-existing runs. */
  activeExecutionMs?: number;
  /** True when activeExecutionMs was derived from completedAt - startedAt. */
  durationIsWallClock?: boolean;
  byHarness: Partial<Record<HarnessId, LifetimeHarnessContribution>>;
}
```

`LifetimeHarnessContribution` carries the same fields
`ObservedHarnessUsageDayContribution` does (input / output / cachedInput /
cacheCreated / reasoningOutput / total / costUsd / costSources / costPartial /
partial) plus `attemptCount` and `reportedAttemptCount`, all read straight off
`WorkflowTokenTotals.byHarness` — no new parsing, no second pass over
`events.jsonl`.

**No run is ever excluded from the totals, at any repo size.** Power users with
the most history are exactly the users this page is for. There is no cap on runs
counted, and no age past which a run stops contributing.

**A run of any age can be revised, and the totals must follow.**
`RunContinuationService.validateContinuationTarget`
(`RunContinuationService.ts:38-111`) accepts any `runRef`; its gates are lock
state, pending edits, and execution state, and there is **no age check anywhere**.
Appending to, continuing, or editing a year-old run is supported product
behavior. Doing so refires the terminal feed for the same
`(workflowKey, runRef)` with a larger `tokenTotals`, so the store must be able
to replace that run's prior contribution no matter how old it is. Any design
that can only revise _recent_ runs is a double-counting bug, not a trade-off.

What _is_ bounded is memory and the size of the always-read file — a different
thing from capping the data, and the design has to keep them separate. Three
rules:

1. **The displayed totals never require reading a per-run ledger.** Persist
   `.ctrlyoke/.usage/lifetime-stats.json` as a document sized by _lineage_
   count, not run count: grand `totals`, `byHarness`, `outcomes`, and a
   per-lineage entry holding that lineage's subtotal plus its counted interval.
   Opening the page parses a small file whether the workspace has 100 runs or
   10 million.
2. **Idempotence comes from a counted-interval index, not a per-run set.** Run
   refs are timestamp-ordered by construction (`run-<ISO>`, see
   `WorkflowPaths.formatRunRef`), so per lineage it is enough to store one
   contiguous interval `{ countedFrom: RunRef, countedThrough: RunRef }`. A run
   inside its lineage's interval is already counted; a run outside it is not.
   That is **O(lineages) state, not O(runs)**. The live feed raises
   `countedThrough`; the backfill lowers `countedFrom`.
3. **Revision of an already-counted run recomputes that one lineage.** When a
   feed arrives for a run _inside_ its lineage's interval, that is a revision:
   discard the lineage's stored subtotal and re-derive it by reading that
   lineage's run manifests, then swap it into the grand totals. No per-run
   contribution needs to have been retained, so **there is no age limit and no
   count limit on what can be revised** — a run from any year re-reads the same
   way as one from this morning. Cost is O(runs in that one lineage), paid only
   on the rare revision path; the common path (a brand-new run finishing,
   landing outside the interval) stays an O(1) add.

The persisted document, stated explicitly so it is not inferred from the prose
above — note there is no run-keyed collection anywhere in it:

```typescript
interface LifetimeUsageStoreData {
  schemaVersion: typeof LIFETIME_USAGE_SCHEMA_VERSION;
  updatedAt: number;
  /** Grand totals, maintained incrementally. */
  totals: LifetimeHarnessContribution;
  byHarness: Partial<Record<HarnessId, LifetimeHarnessContribution>>;
  outcomes: Record<RunOutcomeBucket, number>;
  runCount: number;
  totalActiveExecutionMs: number;
  wallClockDurationRunCount: number;
  skippedRunCount: number;
  /** One entry per lineage — the only collection, sized by lineage count. */
  lineages: Record<
    WorkflowKey,
    {
      /** This lineage's subtotal; re-derivable from its manifests on revision. */
      subtotal: LifetimeHarnessContribution;
      byHarness: Partial<Record<HarnessId, LifetimeHarnessContribution>>;
      runCount: number;
      outcomes: Record<RunOutcomeBucket, number>;
      activeExecutionMs: number;
      wallClockDurationRunCount: number;
      /** Contiguous counted interval. A run inside it is already counted. */
      countedFrom: RunRef;
      countedThrough: RunRef;
      /** mtime optimization only — never a correctness input. */
      dirMtimeMs?: number;
    }
  >;
}
```

**A bounded recent-contribution cache is an optimization, never the mechanism.**
Repaired terminal transitions can refire for the newest run several times in a
row, and each would otherwise rescan its lineage. Keep the last N runs'
contributions (recommend ~200, workspace-wide) in memory so those hits subtract
directly. This is a **cache whose miss path is correct** — evicting an entry
costs one lineage rescan, never a wrong total. That distinction is the whole
point: the earlier draft of this plan bounded a _ledger_ whose eviction silently
destroyed the ability to revise, which would have broken year-old continuations.

**Full rebuild** remains the backstop: discard the document and re-derive
everything from manifests. Same code path as the backfill with the index
cleared, so no drift is ever permanent.

**Corruption handling** mirrors the observed store exactly: validate on read,
quarantine to `.corrupt-<ts>.json`, return an empty store, surface a safe error
code, never block execution. Because a quarantined file loses the interval
index, recovery re-triggers the backfill rather than silently reporting zero.

### Workflow count — one readdir, not the ledger

Total workflows = lineage directory count via `WorkflowPaths.runsRoot` +
`WorkflowPaths.isLineageDirEntry`. It must **not** be derived from the run
ledger: a lineage whose only artifact is a draft has zero runs but is still a
workflow the user created, and dropping it would make the tile disagree with the
workflow list.

### Backfill for pre-existing runs

Every run that finished before this ships is absent from the store. Yes — the
backfill scrapes `.ctrlyoke/.runs`, reading each run's `manifest.json` (never its
`events.jsonl`) and folding `tokenTotals` + lifecycle fields into the totals.

**The existing config gate covers both stores** (decided). `feedObservedHarnessUsage`
early-returns on `ConfigurationUtils.shouldPersistObservedHarnessUsage()`
(`ConfigurationUtils.ts:756`); after the rename to `feedUsageStores` that one
gate governs the lifetime store too. A user who has turned off usage persistence
has opted out of usage persistence — adding a second independent setting for the
same concern is scope creep and gives the page a state where lifetime totals
advance while observed usage does not. When the gate is off, the Stats page
shows its existing empty/partial state; the backfill still works on demand,
since it reads manifests rather than writing accumulated telemetry.

**What it does:**

- Walk lineages; for each, list its run directories and scan only the runs
  outside that lineage's counted interval. A fully-counted lineage costs one
  `readdir` and zero manifest reads.
- **Bounded concurrency** — mirror `getRunSummaries`' batch size of 32. Parse and
  discard per batch; never hold all manifests in memory. `WorkflowRunManifest`
  carries an optional `initialDefinition` snapshot, so a naive
  `Promise.all(readAll)` over a large repo is an extension-host OOM candidate
  (see the crash-investigation note in `.github/copilot-instructions.md`).
- Persist the interval index periodically during the scan, not only at the end,
  so an interrupted pass resumes instead of restarting. A long scan is
  acceptable; **losing** a long scan is not.
- Triggered on first Stats page open, not on activation. Report progress
  (`backfill: { state, scanned, total }`) so a large repo shows "Building
  history… 340/1200" rather than a wrong-looking small number, and let the page
  render partial totals while it runs, clearly labeled as still building.
- Skip manifests that fail to read or parse; count them into a `skippedRuns`
  figure the page discloses rather than silently under-reporting.

**On the "has `.runs` changed since last scrape?" heuristic — yes, but not a
single root mtime.** A directory's mtime changes only when _its own_ entries
change. Creating a new lineage bumps `.runs`, but adding a run inside an
existing lineage bumps only that lineage's directory — so a root-level
`.runs` mtime check would miss almost every new run. Correct shape:

- **Per-lineage directory mtime**, stored beside that lineage's counted
  interval. Unchanged mtime → skip the lineage's `readdir` entirely.
- **The counted interval is the correctness mechanism; mtime is only the
  optimization.** If an mtime is stale, wrong, or unsupported by the filesystem,
  the interval check still yields the right answer on the next `readdir` — it
  just costs one extra syscall per lineage. Never let a skipped mtime comparison
  be the only thing standing between a run and being counted.

**Do not copy `HistorySearchIndexService.isManifestFresh`.** It stats _and reads
every run manifest_ on every freshness check (`HistorySearchIndexService.ts:337-380`)
— O(runs) I/O just to decide whether work is needed. It also writes a
`historyRootMtimeMs` field it never reads back, which is precisely the
root-mtime trap described above. At the scale this page must support, that
approach is the bug.

### Execution time needs a durable source

`WorkflowRunManifest` has `startedAt` / `completedAt` only — wall clock,
including pauses. The pause-aware number lives in `WorkingFileRuntime`
(`startTime` / `totalPausedDuration` / `executionEndTime`) and in `QueueState.totalExecutionTime`.

**Add an optional `activeExecutionMs` to `WorkflowRunManifest`** (decided —
`src/types/WorkflowTimelineTypes.ts`), written by the existing `finalizeRun`
path. It is an additive optional field, so no timeline schema-version bump is
needed, and it avoids a second file read per run at the feed site. Backfilled
runs fall back to `completedAt - startedAt` with `durationIsWallClock: true`,
and the page discloses the mix ("includes N runs measured as wall clock")
rather than blending the two silently.

**No `workflow-schema.json` change is needed for this field.** `jsonValidation`
maps only `**/*.ctrlyoke.json` to that schema (`package.json:751-757`);
`manifest.json` is not validated by it. Keep `activeExecutionMs` on the manifest
only — the working file's `_runtime` already carries `startTime` /
`totalPausedDuration` / `executionEndTime`, so writing a derived duration there
too would duplicate state. If a future change _does_ put it in the working file,
note that `runtimeMetadata` is `additionalProperties: false`, so it must be
declared in the schema in the same commit or every working file starts
squiggling.

---

## Product Shape

### Tab placement

Add to `ALL_TABS` in `GlobalSettingsDrawer.tsx`:

```typescript
{ id: "stats", label: "Stats & Usage", icon: "codicon-graph" }
```

Place it immediately after `general`. It renders inside the standard scrollable
wrapper (not the `workflow` tab's special flex path). `effectiveActiveTab`
already falls back to `general` for unknown ids, so a persisted tab id needs no
migration.

**The drawer is the intended home, not a waypoint** (decided) — a stats page
inside settings is a common, expected pattern, and header space is too scarce to
spend a dedicated button on it. But `StatsUsageSection` must not assume a drawer
parent: no reliance on drawer-owned scope/scroll/measurement context, and every
prop it needs comes in explicitly. Relocating it later should be a change to
where it is mounted, nothing more.

The page requests data **on tab activation, not on drawer open** — the drawer
already sends `GLOBAL_SETTINGS_LOAD_REQUEST` on open and must not get slower.

### Page layout, top to bottom

1. **Header row** — "Workspace statistics" + scope note ("This workspace only")
   - `Refresh` + `Export` split button.
2. **Headline tile grid** — the six Tier 1 tiles. Responsive: 3-up, collapsing
   to 2-up then 1-up. The drawer already measures narrowness via
   `useElementNarrow(580)`; reuse that boolean rather than adding a second
   measurement.
3. **Harness share** — metric toggle + share bar + ranked rows.
4. **Per-harness usage cards** — the moved `UsageCard` list, one per
   `HARNESS_IDS` entry, each labeled with `HARNESS_INFO[id].name` and
   `HarnessIcon`.
5. **Provenance footer** — "Totals are ctrlyoke-observed only; they do not
   include harness activity outside ctrlyoke. Costs are estimates at API list
   prices, not subscription spend."

### Harness share visual

**Recommendation: a horizontal 100% stacked share bar plus a ranked row list.
Not a pie.**

Reasons, in order of weight:

- Six categories where most workspaces will have one dominant harness and two or
  three slivers. A pie renders those slivers as unreadable wedges with unplaceable
  labels; a stacked bar keeps them as visible strips with the numbers in the rows
  beside it.
- The drawer is resizable and goes narrow (`isNarrow` at 580px). A bar degrades
  gracefully at any width; a pie needs a square aspect and a legend that competes
  for the same space.
- Comparing magnitudes is the actual task ("roughly how many prompts to each"),
  and length-along-a-common-axis is read more accurately than angle.
- No charting library. It is a flex row of `div`s with percentage widths — no
  bundle cost in a webview bundle shared with the hosted browser client, and no
  CSP concerns.

**Metric toggle** — a two-option `ScopeToggle` (already a shared component):

- **By AI steps** (default) — `attemptCount` share. Answers "how many prompts did
  I send to each".
- **By tokens** — `total` share. Answers "where did the volume go".

Both are worth having because they disagree in an informative way: a harness used
for a handful of enormous refactors and one used for fifty one-liners swap
positions between the two views.

**Rows**, sorted descending by the selected metric, one per harness with a
non-zero value:

```
[icon] Claude Code    62%   1,284 steps · 41.2M tokens · ≈$38.20
```

Harnesses with zero usage collapse into a muted "Unused: Qwen Code, OpenCode"
line rather than rendering five empty rows.

**Colors** — add `HARNESS_CHART_COLORS: Record<HarnessId, string>` to
`DashboardConstants.ts`, built from `--vscode-charts-*` with hex fallbacks,
following the existing `CHART_ACCENT_COLORS` precedent in
`utils/atomicReferences.ts` (blue / green / purple / red / yellow, plus orange
for the sixth). Theme-aware and consistent with the rest of the app; do not
invent a palette.

Note the deliberate constraint documented on `CHART_ACCENT_COLORS`: those five
are "the only saturated, mutually-distinct accent colors verified present in
every sampled VS Code theme." Six harnesses need a sixth color, so
`--vscode-charts-orange` is used **with a hex fallback**
(`var(--vscode-charts-orange, #d18616)`) — the fallback is what makes adding it
safe in themes that omit the variable, and it is why this does not contradict
that comment. Do not widen `CHART_ACCENT_COLORS` itself; `HARNESS_CHART_COLORS`
is a separate harness-keyed map.

**Accessibility** — the bar is `aria-hidden`; the rows are the accessible
source of truth and carry the real numbers as text. Each bar segment gets a
`title` for hover, and the whole bar sits inside a container with an
`aria-label` naming the metric. Never encode a value only as color.

### Export

Split button with three actions:

- **Copy summary (Markdown)** — clipboard, for pasting into an issue or chat.
- **Download Markdown**
- **Download JSON** — machine-readable, versioned (`schemaVersion`).

Reuse the dual-host pattern already in `hooks/useOutputExport.ts:128-143`: Blob +
anchor download when `isStandalone`, `EXPORT_OUTPUT` postMessage otherwise. Build
the payload in the webview from data already in the store — no new export
round-trip through the extension.

**Privacy is the load-bearing requirement here.** The stated purpose is sharing
totals publicly, so the export must contain **only** aggregate numbers, harness
ids, period boundaries, provenance labels, and the disclaimer. It must never
contain workflow names, workflow keys, run refs, file paths, model ids tied to a
specific run, or any provider account detail. This is a hard rule with its own
test, not a code-review convention.

Every export carries a header: workspace-local scope, generation timestamp, the
ctrlyoke-observed caveat, and the cost-estimate caveat. When `ui.hideCost` is on,
cost is omitted from the page **and** from the export.

---

## Architecture

### Core

- `LifetimeUsageStore` (`src/core/harness/shared/usage/LifetimeUsageStore.ts`) —
  the persisted ledger + totals described above.
- `WorkspaceStatsService` (`src/core/harness/shared/usage/WorkspaceStatsService.ts`) —
  composes the lifetime store, the lineage count, and the backfill scanner into
  one `WorkspaceStatsSnapshot`. Owns the backfill's progress state and
  concurrency bound. Never blocks execution; every failure degrades to a partial
  snapshot with a safe error code.
- `lifetimeStatsPath(workspaceRoot)` added to `src/utils/UsagePaths.ts`.
- `activeExecutionMs?: number` added to `WorkflowRunManifest`
  (`src/types/WorkflowTimelineTypes.ts`), written at `finalizeRun`.

### Types

`src/types/UsageTypes.ts` gains `WorkspaceStatsSnapshot`:

```typescript
export interface WorkspaceStatsSnapshot {
  updatedAt: number;
  workflowCount: number;
  runCount: number;
  outcomes: Record<RunOutcomeBucket, number>;
  totalActiveExecutionMs: number;
  /** Runs whose duration is wall clock rather than pause-aware. */
  wallClockDurationRunCount: number;
  /** Runs the backfill could not read. Disclosed, never silently dropped. */
  skippedRunCount: number;
  totals: LifetimeHarnessContribution;
  byHarness: Partial<Record<HarnessId, LifetimeHarnessContribution>>;
  backfill: {
    state: WorkspaceStatsBackfillState;
    scanned: number;
    total: number;
  };
  errorCode?: string;
}
```

Per the existing convention, `RunOutcomeBucket` and
`WorkspaceStatsBackfillState` are `const` objects in `DashboardConstants.ts` with
the union types derived from them — no handwritten parallel string unions.

### Messages

Add to `MESSAGE_TYPES`: `REQUEST_WORKSPACE_STATS`, `REFRESH_WORKSPACE_STATS`,
`WORKSPACE_STATS_UPDATED`. Route through `WebviewMessageRouter` beside the
existing `REQUEST_HARNESS_USAGE` / `REFRESH_HARNESS_USAGE` handlers
(`WebviewMessageRouter.ts:1135-1154`), following the same shape: `REQUEST_*`
answers from cache immediately and kicks a background refresh; `REFRESH_*`
awaits. Payload shape mirrors `HarnessUsageUpdatedMessage` in
`WebviewMessageTypes.ts`.

Register `ctrlyoke.refreshWorkspaceStats` in `package.json` + `extension.ts`
beside the existing `ctrlyoke.refreshHarnessUsage`.

### Webview

- New store `store/workspaceStatsStore.ts` — separate from `harnessUsageStore`;
  different shape, different lifecycle, different refresh cadence.
- New components under `components/settings/stats/`:
  - `StatsUsageSection.tsx` — the page shell, registered in the drawer.
  - `StatTileGrid.tsx`, `HarnessShareBar.tsx`, `HarnessShareRow.tsx`.
  - `UsageCard.tsx` — **moved out of** `HarnessesSection.tsx`, exported so its
    existing test keeps a target.
- New `utils/workspaceStatsExport.ts` — builds the Markdown and JSON payloads.
  Pure function over the snapshot so the privacy rule is unit-testable without
  rendering.
- Formatting reuses `@root/utils/TokenFormatting` (`formatTokenCount`,
  `formatTokenTotal`, `formatCostLabel`, `formatCostSourcePhrase`) and the
  existing duration helpers. Do not add a second token/cost formatter.

---

## Implementation Phases

### Phase 1 — Move the existing usage UI

- [x] Extract `UsageCard` out of `HarnessesSection.tsx` into
      `components/settings/stats/UsageCard.tsx`.
- [x] Add the `stats` tab to `GlobalSettingsDrawer.tsx` + `StatsUsageSection.tsx`
      rendering the per-harness cards and the refresh button.
- [x] Remove the cards, the refresh button, and the mount-time
      `REQUEST_HARNESS_USAGE` from `HarnessesSection.tsx`; it becomes
      defaults-only. (`HarnessQuickPicker.tsx:73` still requests usage for the
      footer chip, so removing this one does not starve the chip.)
- [x] Move/split `test/components/settings/HarnessesSection.test.tsx` so the
      usage assertions follow the component.

Phase 1 is independently shippable and is the fix for the stated problem.

### Phase 2 — Lifetime totals

- [x] Add `activeExecutionMs` to `WorkflowRunManifest`, written at `finalizeRun`.
- [x] Add `lifetimeStatsPath` to `UsagePaths.ts`.
- [ ] Add `LifetimeUsageStore`: lineage-sized totals document, per-lineage
      counted-interval index, revision-by-lineage-recompute, bounded recent
      contribution cache, corruption recovery, full rebuild.
- [ ] Regression test: continuing a run older than any cache horizon updates the
      totals without double-counting.
- [ ] Extend `OutputHistoryManager.feedObservedHarnessUsage` → `feedUsageStores`
      to feed both stores from its single manifest read.
- [ ] Add `WorkspaceStatsService` + the bounded-concurrency backfill scanner
      with per-lineage mtime gating and mid-scan checkpointing.
- [ ] Add messages, router handlers, command registration, `workspaceStatsStore`.
- [ ] Render the headline tile grid, including backfill progress and the
      skipped/wall-clock disclosures.

### Phase 3 — Harness share

- [ ] Add `HARNESS_CHART_COLORS` to `DashboardConstants.ts`.
- [ ] Build `HarnessShareBar` + ranked rows + the steps/tokens metric toggle.
- [ ] Collapse zero-usage harnesses into the muted "Unused" line.

### Phase 4 — Export

- [ ] `workspaceStatsExport.ts` producing Markdown + versioned JSON.
- [ ] Split button wiring with the standalone/VS Code dual-host branch.
- [ ] Privacy test asserting no identifier ever reaches either payload.

---

## Acceptance Criteria

- `DefaultsHarnessPage` / `HarnessesSection` render no usage data and send no
  usage messages; every usage surface in the drawer lives on the Stats page.
- Lifetime totals derive only from persisted `WorkflowTokenTotals`; nothing on
  this page reparses `events.jsonl`, OTel spans, or provider transcripts.
- Repeated terminal notifications and same-run continuations replace one durable
  run contribution rather than double-counting — same guarantee the observed
  store already makes.
- Workflow count includes draft-only lineages; run count does not.
- Duration is pause-aware where available, and the page discloses how many runs
  fall back to wall clock rather than blending the two silently.
- **No run is ever excluded from the totals for being old or for exceeding a
  count threshold**, and **no run ever becomes unrevisable.** Appending to,
  continuing, or editing a run of any age updates the totals correctly, with no
  double-counting. Regression test: count a run, advance the clock past any
  cache/window horizon, evict the recent-contribution cache, continue that run,
  and assert the totals reflect the new value rather than the sum of both.
- The always-read stats document and the per-lineage index are O(lineages), not
  O(runs): totals for a workspace with millions of runs load without parsing a
  per-run ledger.
- Backfill is bounded in concurrency and memory, resumable across interruption
  via mid-scan checkpoints, idempotent, and reports progress; unreadable
  manifests are counted and disclosed, never silently dropped.
- Freshness gating never determines correctness: with every directory mtime
  stale or unavailable, the counted-interval check still counts every run.
- A full rebuild reproduces the same totals as incremental accumulation.
- The share bar is never the only encoding of a value; the rows carry the
  numbers as text and the bar is `aria-hidden`.
- Zero-usage harnesses never render as an empty row or a zero-width segment.
- Export payloads contain no workflow name, workflow key, run ref, file path, or
  account identifier, and carry the scope + estimate disclaimers.
- `ui.hideCost` suppresses cost on the page and in every export format.
- Stats collection, backfill, refresh failures, and malformed store files are
  all non-blocking for workflow execution.
- Opening the settings drawer is no slower than before; stats load on tab
  activation.

---

## Decisions

Resolved August 11, 2026:

1. **The Stats page stays in the settings drawer.** A stats page inside settings
   is a standard pattern, and header space is too scarce to spend a dedicated
   button on it. No move is planned — but `StatsUsageSection` stays portable
   (no drawer-parent assumptions) so a later move is a mount-point change.
2. **No cap on counted runs, and no limit on which runs can be revised.** Power
   users with the largest histories are the audience for this page. Waiting for
   a long scrape is acceptable; being silently capped is not. Continuing or
   editing a year-old run is supported product behavior
   (`RunContinuationService` has no age gate), so the store re-derives the
   affected lineage rather than relying on a retained per-run record. The only
   bounded things are the always-read document (sized by lineage count) and an
   in-memory cache whose miss path is a correct rescan. See
   [Lifetime totals](#lifetime-totals--new-store-required).
3. **`activeExecutionMs` is added to `WorkflowRunManifest`.** Manifest only; no
   `workflow-schema.json` entry needed, since that schema validates
   `**/*.ctrlyoke.json` and not `manifest.json`.
4. **The backfill scrapes `.ctrlyoke/.runs`, gated by per-lineage directory
   mtime — not a single `.runs` root mtime.** A root-level check would miss runs
   added inside existing lineages. mtime is an optimization layered over the
   counted-interval index, which remains the correctness mechanism. See
   [Backfill](#backfill-for-pre-existing-runs).
5. **`shouldPersistObservedHarnessUsage` gates the lifetime store too.** One
   setting for one concern; a second toggle would allow lifetime totals to
   advance while observed usage is frozen. See
   [Backfill](#backfill-for-pre-existing-runs).
6. **`LifetimeRunContribution` is an in-flight shape, not a persisted one.** The
   persisted document is keyed by lineage and contains no run-keyed collection —
   the explicit `LifetimeUsageStoreData` shape is given under
   [Lifetime totals](#lifetime-totals--new-store-required). Persisting per-run
   records is the specific bug this design exists to avoid.

## Open Questions

1. **Recent-contribution cache size.** ~200 entries is a starting guess. Because
   a miss only costs a lineage rescan, this is purely a performance dial and can
   be tuned (or dropped entirely) without affecting correctness. Worth revisiting
   if a workspace turns out to have single lineages with very large run counts,
   since those make the miss path more expensive.
2. **Should the backfill run automatically on activation** instead of first page
   open? Recommend no — it is a full-history scan whose only consumer is a page
   most sessions never open, and on a very large workspace it is exactly the kind
   of background I/O that should be user-initiated.

---

## Appendix — Working-File Schema Squiggles (fixed alongside this plan)

While confirming that `activeExecutionMs` needed no schema change, a validation
sweep of all 1,020 working files under `.ctrlyoke/.runs` found **862 of them
already failing** `schemas/workflow-schema.json`. Fixed in the same change:

| Cause                                                                                                             | Files | Fix                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------- |
| `agent: ""` — the serialized form of the dashboard's "None" selection, rejected by the `^[a-zA-Z0-9-_]+$` pattern | 858   | Added an explicit empty-string branch to `agent`, documenting `""` = none as distinct from `null` = explicitly disabled |
| `_runtime.tokenTotals` undeclared under `additionalProperties: false`                                             | many  | Added a `workflowTokenTotals` / `harnessTokenTotals` definition pair                                                    |
| `_runtime.pendingRewind` undeclared                                                                               | some  | Declared                                                                                                                |
| `_runtime.finalStep.preCondition` / `.endCondition` undeclared                                                    | 22    | Added a `conditionEvaluationSummary` definition                                                                         |

Result: 862 → **30** failing files. The remaining 30 fail on genuinely wrong
content and **should** keep squiggling:

- 25 files declare `harness: "copilot-chat"` — the permanently removed harness.
  It must never be reintroduced into the schema
  (`.github/copilot-instructions.md`), so these correctly report as invalid.
- A few carry `agent: "copilot-prompt.chatmode"`; no code path supports a
  `.chatmode` agent form, so the pattern is right to reject it.
- 3 carry a legacy `_runtime.finalStep.responseTexts` no longer on
  `FinalStepRuntimeState`; 2 have a step `_runtime` missing `startedAt`.

`schemas/workflow-schema.yaml` is generated from the JSON schema by
`npm run generate-schema` (part of `precompile`) and was regenerated.
