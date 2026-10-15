# skippedRunCount double-counts after a lineage rescan because per-lineage skipped counts live only in memory

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/core/harness/shared/usage/LifetimeUsageStore.ts`
- **Resolution:** fixed in this commit

## Symptom

Two places overstate how many runs are unreadable: the workspace stats notice "N runs skipped because their manifest..." (`src/ui/webview-react/components/settings/stats/StatTileGrid.tsx:120-122`) and the "Unreadable runs" row in the stats export (`src/ui/webview-react/utils/workspaceStatsExport.ts:226`). The count goes up by the lineage's number of unreadable runs after each extension-host restart in which a run in that lineage is written again.

## Steps to Reproduce

1. In one workflow lineage, create K run directories whose `manifest.json` is missing or is not valid JSON, plus at least one readable run.
2. Let `WorkspaceStatsService` backfill the lineage. `applyBackfillBatch` adds K to `data.skippedRunCount` (`LifetimeUsageStore.ts:783` and `:791`), and the lifetime stats show K skipped runs.
3. Restart the extension host, or construct a new `LifetimeUsageStore` for the same workspace. `lineageSkippedRunCounts` and `recentContributionCache` start empty.
4. Resume or re-save an existing run in that lineage whose `runRef` falls inside `[countedFrom, countedThrough]`, so its `manifest.json` is written again. `feedUsageStores` calls `upsertRunContribution`. The cache misses, so the code takes the `scanLineage` + `replaceLineage` branch (lines 723-724).
5. `replaceLineage` computes `skippedRunCount = K - 0 + K = 2K`. Each further restart and re-save adds K again (3K, 4K, and so on).

## Root Cause

The per-lineage skipped count is kept only in memory, in `lineageSkippedRunCounts` (`LifetimeUsageStore.ts:628`). `replaceLineage` reads it at lines 859-860 and treats a missing entry as 0. It then sets `data.skippedRunCount - previous + next` at lines 869-872.

Three other gaps let the count drift:

- `applyBackfillBatch` (lines 783 and 791) increments `data.skippedRunCount` but never records the per-lineage count.
- `LineageData` in the persisted document has no `skippedRunCount` field.
- `recomputeGrandTotals` (lines 344-354) does not rebuild `skippedRunCount` from the lineages.

After a restart, or for any lineage that only backfill has counted, the subtraction removes nothing. The rescanned unreadable runs are then added on top of the ones already counted.

## Suggested Fix

Store the skipped count per lineage in the persisted document:

- Add a `skippedRunCount` field to `LineageData`.
- In `applyBackfillBatch`, increment it next to `data.skippedRunCount`.
- In `replaceLineage`, set it from `scanned.skippedRunCount`.
- Derive `data.skippedRunCount` as the sum of `lineage.skippedRunCount`, in `recomputeGrandTotals` or `replaceLineage`.
- Delete the in-memory `lineageSkippedRunCounts` map.

Old documents have no per-lineage field, so they need to be rebuilt. Either bump the persisted schema or extend the reset guard (the lineage `requiredNumeric` checks around lines 520-550) to require the new field.

Add a `LifetimeUsageStore` test for this case:

1. Backfill a lineage that has an unreadable run.
2. Create a fresh store instance.
3. Upsert an in-range run that has `costSources`.
4. Assert that `skippedRunCount` has not changed.
