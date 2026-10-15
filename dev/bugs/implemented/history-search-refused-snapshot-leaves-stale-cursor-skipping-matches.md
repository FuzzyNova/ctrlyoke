# Refused snapshot store leaves a stale cursor whose shared dedupe set was already advanced, silently skipping matches

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/core/orchestration/HistorySearchIndexService.ts`
- **Resolution:** fixed in this commit

## Symptom

This affects a history search with more than 50,000 matches. Suppose a page request's extension scans to the end of the index. After that, any request past the old retained snapshot prefix reports a smaller exact `totalCount`. The matches from the oldest `startedAt` group (the last runs in shard order) are missing from every later page. They stay missing until the snapshot is evicted or the index changes. Nothing is logged except the earlier `match snapshot not retained` line.

## Steps to Reproduce

1. Create history where one query matches more than 50,000 events across many runs. The last run(s) in shard order (the oldest `startedAt` group) must contain matches.
2. Search the query at offset 0 with a small limit. The snapshot is stored with an incomplete cursor (`countState` `atLeast`).
3. Request a page far enough out that `extendSnapshotAndRespond` scans to the end of the index (`complete = true`) and the combined results go over 50,000. The response is correct and `totalCount` is exact (N). However, `storeSnapshot` logs `match snapshot not retained` and keeps the old snapshot.
4. Request any page whose offset is past the old snapshot's `results.length`. `extendSnapshotAndRespond` resumes from the old cursor. The final group's dedupe keys are still in the shared `seenDedupeKeys` set, so those matches are skipped. `totalCount` is now N minus the size of that group, and those rows never appear.

## Root Cause

`scanForMatches` reuses `resume.seenDedupeKeys` by reference (line 639). Keys go into it in `finalizeGroup` (lines 657-661).

- `admissionsCommitted = true` is set at line 855. That is only after the `try`/`finally` (lines 676-822) has finished, so the rollback in the `finally` (lines 815-821) always runs. It removes every key admitted by groups finalized inside the loop, including on success.
- The trailing `finalizeGroup()` at line 845 runs only when the scan reaches the end (`!stoppedEarly`). It runs after the `finally`, so its keys stay in the shared set and are never rolled back.
- `extendSnapshotAndRespond` (lines 450-483) passes the combined results to `storeSnapshot`. When `results.length > MAX_SNAPSHOT_RESULTS` (line 527), `storeSnapshot` returns early and leaves the previous snapshot in place. That snapshot's cursor is still incomplete. It still has the old `nextShardIndex`, and it shares the Set that was just mutated.
- The next extension (called from line 268 or 319) rescans the final group and drops every match in it as already seen (line 657).

Related: `admissionsCommitted` is effectively dead code. Its documented purpose is to keep admissions on success, but keys from groups finalized inside the loop are rolled back anyway. Whether a successful resumed scan keeps its keys therefore depends on where each group was finalized, not on whether the results were retained.

## Suggested Fix

Make sure the shared set and the retained cursor always change together:

- **(a)** Have `scanForMatches` return `addedDedupeKeys`. When `storeSnapshot` refuses the combined results in `extendSnapshotAndRespond`, delete those keys from `snapshot.cursor.seenDedupeKeys`. A simpler version is to drop the stale snapshot, or just its cursor, when the store is refused, so a later request rescans from scratch.
- **(b)** Give `storeSnapshot` a return value that says whether it stored the results. On refusal, roll back the keys this scan added.

Either way, fix the misplaced `admissionsCommitted` too. Set it before the `finally` runs, or remove it and do the rollback explicitly at the caller. That way one place decides whether to commit or roll back, based on whether the results were actually retained.

Add a unit test: lower `MAX_SNAPSHOT_RESULTS` (or inject it), run an extension that completes and is refused, then extend again from the old snapshot and check that `totalCount` is unchanged.
