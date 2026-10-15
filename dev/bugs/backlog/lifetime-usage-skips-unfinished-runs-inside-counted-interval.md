# Lifetime usage never counts a run that ended without a terminal upsert

- **Found:** 2026-10-15 by the bug drain 3 review (follow-up to `983ae53a8`)
- **Area:** `src/core/harness/shared/usage/LifetimeUsageStore.ts`, `src/core/harness/shared/usage/WorkspaceStatsService.ts`
- **Severity:** low

## Symptom

A run that was interrupted (extension-host crash, killed CLI, machine sleep) is missing
from lifetime usage for good. It is not in `runCount`, and not in `skippedRunCount`
either, once a later run of the same lineage finishes.

## Steps to Reproduce

1. Run workflow W to completion several times so its lineage is fully backfilled.
2. Start run E and kill the extension host mid-run, so no terminal transition and no
   `upsertRunContribution` happens for E.
3. Run W again to completion (run F). Its upsert extends `countedThrough` to F.
4. Refresh the stats view. E is never counted.

## Root Cause

The upsert append path in `upsertRunContribution` sets `countedThrough` to the new run
without checking for run directories between the old `countedThrough` and the new ref.
The next backfill in `WorkspaceStatsService.backfillLineage` keeps only refs outside
`[countedFrom, countedThrough]` (around lines 307-312), so E, which sits inside the
widened interval, is filtered out. The lineage is neither a live-upsert lineage nor one
with older refs, so no rebuild fires either.

This is the "per-run membership inferred from the interval" problem the step 7 fix closed
for older refs. It remains for refs in the middle of the interval.

## Suggested Fix

In the append path, `readdir` the lineage directory and check for run directories with
`countedThrough < ref < newRef`. If there are any, fall back to the existing rescan
(`scanLineage` + `replaceLineage`), which counts E or adds it to `skippedRunCount`.
Fixing this together with `lifetime-usage-lineage-rescan-holds-store-lock.md` keeps the
extra rescan from holding the lock.
