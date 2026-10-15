# Lifetime backfill permanently drops older runs once the lineage interval already covers a later run

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/core/harness/shared/usage/LifetimeUsageStore.ts`
- **Severity:** medium

## Symptom

Workspace lifetime stats undercount, and the undercount is permanent. For a lineage whose first recorded run came from a live upsert, every older run except the oldest is dropped during backfill. Those runs never reach tokens, cost, `runCount` or `outcomes`, and they are not counted in `skippedRunCount` either. Later backfills never repair the gap. The same loss hits the remaining batch refs when a run finishes while a multi-batch backfill is still in progress.

## Steps to Reproduce

1. Have a workflow W with existing runs A < B < C in `.runs/W/` and no W lineage in `lifetime-stats.json`. This happens on a fresh install of the lifetime-stats feature, or after a malformed file was quarantined.
2. Run W again (run D) without opening the workspace stats view. `OutputHistoryManager` calls `LifetimeUsageStore.upsertRunContribution`, which creates lineage `{countedFrom: D, countedThrough: D, runCount: 1}`.
3. Open the workspace stats view so `getSnapshot` starts the backfill. `WorkspaceStatsService.scanLineage` sends the batch `runRefs = [A, B, C]`.
4. `applyBackfillBatch` counts A, which lowers `countedFrom` to A. It then skips B and C because they now fall inside [A, D].
5. Lineage W reports `runCount` 2 instead of 4, and B's and C's tokens, cost and outcomes are missing. Refresh again: the lineage is now marked `backfillComplete` with the current `dirMtimeMs`, so the scan short-circuits and the gap stays.

## Root Cause

`applyBackfillBatch` (`src/core/harness/shared/usage/LifetimeUsageStore.ts:768-774`) skips any runRef inside the lineage's `[countedFrom, countedThrough]` interval. That treats the interval as a contiguous counted range. But the same loop widens the interval to each newly counted ref (`:793-796`), and a live upsert can create or extend the interval at a single non-contiguous run: `createLineage` at `:574-576`, and the append path at `:682-685`. The interval therefore covers runs that were never counted.

`WorkspaceStatsService.scanLineage` (`src/core/harness/shared/usage/WorkspaceStatsService.ts:290-299`) applies the same interval filter, sorts ascending, and batches the below-interval refs (up to `WORKSPACE_STATS_READ_BATCH_SIZE` = 32 each). The first ref of the first batch lowers `countedFrom`. Every later ref, in that batch and in any later batch, then falls inside the widened interval and is swallowed by the `continue`. `markLineageBackfillComplete` (`LifetimeUsageStore.ts:835-841`, which sets the flag at `:826-828`) then marks the lineage complete with the current mtime. The early return at `WorkspaceStatsService.ts:274-281` stops any later scan.

The same contiguity assumption breaks mid-backfill. If `upsertRunContribution`'s append path (`:682-685`) raises `countedThrough` to a new run while a checkpointed backfill (`backfillComplete: false`) is partway through, every remaining older ref in later batches falls inside the interval and is skipped. By contrast, `upsertRunContribution` handles a ref below `countedFrom` correctly with a full rescan (`:679-681`).

## Suggested Fix

Stop inferring per-run membership from the widened interval. Options:

- **(a)** In `applyBackfillBatch`, snapshot `countedFrom`/`countedThrough` before the loop and make the skip decision against that snapshot, so all refs below the original `countedFrom` are counted. This alone does not fix the multi-batch case, because batch 2 sees batch 1's widened interval. So also assert that a batch never straddles the interval.
- **(b)** Simpler and more robust: when the backfill finds refs below `countedFrom` for an existing lineage, or the lineage was created by a live upsert and has never been backfilled, rebuild the lineage from a full scan (`scanLineage` + `replaceLineage`). This is what `upsertRunContribution` already does for refs below `countedFrom`.
- **(c)** Have the upsert append path set `backfillComplete = false` or clear `dirMtimeMs` when it extends a lineage mid-backfill, so the batch loop re-reads a consistent view.

Add tests:

- A lineage seeded by `upsertRunContribution(D)`, followed by a backfill of [A, B, C], must give `runCount` 4.
- A backfill of more than 32 older refs must count all of them.
- An upsert that lands between two backfill batches must not drop the remaining refs.
