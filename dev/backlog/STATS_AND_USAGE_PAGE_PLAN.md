# Stats & Usage Page Plan

**Status:** Not started — plan only
**Related:** `dev/implemented/HARNESS_USAGE_TRACKING_PLAN.md`,
`dev/implemented/PROMPT_TOTAL_TOKEN_USAGE_PLAN.md`

---

## Problem

`HARNESS_USAGE_TRACKING_PLAN.md` shipped its usage cards into
`HarnessesSection.tsx`, which is rendered by `DefaultsHarnessPage.tsx` — the
**Workflow Defaults → Harness** page. That page exists to set defaults (default
harness, per-harness model, per-harness extra args). It now also carries:

- a `UsageCard` per harness (`HarnessesSection.tsx:71-176`)
- a "Refresh harness usage" button (`HarnessesSection.tsx:206-212`)
- a mount-time `REQUEST_HARNESS_USAGE` postMessage (`HarnessesSection.tsx:184-186`)

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

Per-run contribution recorded:

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

**Idempotence and bounding.** Same `(workflowKey, runRef)` upsert semantics as
`ObservedHarnessUsageStore`: keep the per-run ledger so a replacement can
subtract the old contribution and add the new one. Unlike the observed store the
ledger is never date-pruned, so bound it by count instead: past
`LIFETIME_LEDGER_MAX_RUNS` (recommend 5000) fold the oldest entries into a
sealed `archivedTotals` object that can no longer be revised. Terminal runs are
not revised in practice, so sealing the tail is safe; sealing is what keeps the
file from growing without limit in a repo with tens of thousands of runs.

**Corruption handling** mirrors the observed store exactly: validate on read,
quarantine to `.corrupt-<ts>.json`, return an empty store, surface a safe error
code, never block execution.

### Workflow count — one readdir, not the ledger

Total workflows = lineage directory count via `WorkflowPaths.runsRoot` +
`WorkflowPaths.isLineageDirEntry`. It must **not** be derived from the run
ledger: a lineage whose only artifact is a draft has zero runs but is still a
workflow the user created, and dropping it would make the tile disagree with the
workflow list.

### Backfill for pre-existing runs

Every run that finished before this ships is absent from the ledger. Add a
one-time background backfill:

- Scan `.ctrlyoke/.runs/*/run-*/manifest.json` for run refs not in the ledger.
- **Bounded concurrency** — mirror `getRunSummaries`' batch size of 32. Parse and
  discard per batch; never hold all manifests in memory. `WorkflowRunManifest`
  carries an optional `initialDefinition` snapshot, so a naive
  `Promise.all(readAll)` over a large repo is an extension-host OOM candidate
  (see the crash-investigation note in `.github/copilot-instructions.md`).
- Triggered on first Stats page open, not on activation. Report progress to the
  page (`backfill: { state, scanned, total }`) so a large repo shows "Building
  history… 340/1200" rather than a wrong-looking small number.
- Idempotent and resumable: re-running it after a partial pass converges.
- Skip manifests that fail to read or parse; count them into a
  `skippedRuns` figure the page discloses rather than silently under-reporting.

### Execution time needs a durable source

`WorkflowRunManifest` has `startedAt` / `completedAt` only — wall clock,
including pauses. The pause-aware number lives in `WorkingFileRuntime`
(`startTime` / `totalPausedDuration` / `executionEndTime`) and in `QueueState.totalExecutionTime`.

**Add an optional `activeExecutionMs` to `WorkflowRunManifest`**, written by the
existing `finalizeRun` path. It is an additive optional field, so no timeline
schema-version bump is needed, and it avoids a second file read per run at the
feed site. Backfilled runs fall back to `completedAt - startedAt` with
`durationIsWallClock: true`, and the page discloses the mix ("includes N runs
measured as wall clock") rather than blending the two silently.

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
following the existing precedent in `utils/atomicReferences.ts:253-257`
(blue / green / purple / red / yellow, plus orange for the sixth). Theme-aware
and consistent with the rest of the app; do not invent a palette.

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

- [ ] Extract `UsageCard` out of `HarnessesSection.tsx` into
      `components/settings/stats/UsageCard.tsx`.
- [ ] Add the `stats` tab to `GlobalSettingsDrawer.tsx` + `StatsUsageSection.tsx`
      rendering the per-harness cards and the refresh button.
- [ ] Remove the cards, the refresh button, and the mount-time
      `REQUEST_HARNESS_USAGE` from `HarnessesSection.tsx`; it becomes
      defaults-only. (`HarnessQuickPicker.tsx:73` still requests usage for the
      footer chip, so removing this one does not starve the chip.)
- [ ] Move/split `test/components/settings/HarnessesSection.test.tsx` so the
      usage assertions follow the component.

Phase 1 is independently shippable and is the fix for the stated problem.

### Phase 2 — Lifetime totals

- [ ] Add `activeExecutionMs` to `WorkflowRunManifest`, written at `finalizeRun`.
- [ ] Add `lifetimeStatsPath` to `UsagePaths.ts`.
- [ ] Add `LifetimeUsageStore` with upsert/idempotence/sealing/corruption
      recovery.
- [ ] Extend `OutputHistoryManager.feedObservedHarnessUsage` → `feedUsageStores`
      to feed both stores from its single manifest read.
- [ ] Add `WorkspaceStatsService` + the bounded-concurrency backfill scanner.
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
- Backfill is bounded in concurrency and memory, resumable, idempotent, and
  reports progress; unreadable manifests are counted and disclosed, never
  silently dropped.
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

## Open Questions

1. **Should the Stats page eventually leave the settings drawer?** It is not a
   settings surface, and a workspace-statistics view may deserve its own panel
   entry. Ship it in the drawer (that is what was asked for and it is where the
   usage cards already are), but do not build anything that assumes a drawer
   parent — keep `StatsUsageSection` self-contained so relocating it is a
   one-line change.
2. **Ledger cap value.** 5000 runs is a guess. Worth measuring the real file size
   of a contribution before fixing the constant.
3. **Should the backfill run automatically on activation** instead of first page
   open? Recommend no — it is a full-history scan whose only consumer is a page
   most sessions never open.
