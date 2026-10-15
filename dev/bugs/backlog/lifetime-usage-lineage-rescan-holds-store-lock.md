# Lifetime usage lineage rescans run while holding the store file lock

- **Found:** 2026-10-15 by the bug drain 3 review (follow-up to `983ae53a8`)
- **Area:** `src/core/harness/shared/usage/LifetimeUsageStore.ts`
- **Severity:** medium

## Symptom

On a lineage with many runs, or on a slow or synced disk (OneDrive, Dropbox), a stats
refresh or a run-end upsert can take longer than the 5 s lock timeout. While it runs:

- a concurrent `getSnapshot` read fails with `STORE_READ_FAILED`;
- a run-end `upsertRunContribution` fails and only logs a warning, so that run is not
  counted until the next rebuild.

If the scan passes the 30 s stale threshold, another process can break the lock and
write over the store while the first one is still scanning.

## Steps to Reproduce

1. Make a lineage with several hundred runs in user-scoped history on a slow disk.
2. Upsert a newer run before the first backfill, so the lineage is a live-upsert
   lineage (or delete `lifetime-stats.json` so it rebuilds).
3. Open the stats view and, in parallel, finish a workflow run in the same project.
4. The refresh holds the lock through `scanLineage`, and the concurrent read or upsert
   times out.

## Root Cause

`scanLineage` reads every run manifest in the lineage one after another. It is called
inside `withFileLock(this.filePath, …)` from four places:

- the below-`countedFrom` and mid-backfill branches of `upsertRunContribution`
  (around lines 686-750);
- the older-refs rebuild branch of `applyBackfillBatch` (around line 798);
- `rebuildLineage` (around line 868).

`withFileLock` gives up after `LOCK_TIMEOUT_MS = 5000` and treats a lock as stale after
`LOCK_STALE_MS = 30000`, with no heartbeat (`src/utils/FileLockUtils.ts`). This undoes the
32-run batching in `WorkspaceStatsService`, which exists to keep lock holds short. Step 7
of bug drain 3 added three of these four entry points.

## Suggested Fix

Scan outside the lock, then lock, re-read the document and `replaceLineage` with the
scanned result:

- If the lineage's `countedThrough` moved while the scan ran, rescan, or merge the newer
  upserted refs onto the scan result.
- Share one helper across the four call sites so the lock is only ever held for the
  read-modify-write.
