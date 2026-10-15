# normalizeStaleLocks can delete a successor's runner lock and overwrite its run state

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/utils/WorkflowLockManager.ts`
- **Resolution:** fixed in this commit

## Decision

`updateHeartbeat` keeps its existing `Promise<void>` contract; stale reclamation now
preserves successor ownership without requiring changes to its callers.

## Symptom

A window that starts up while another window resumes or continues a lineage whose previous runner crashed can delete the new runner's `runner.json`. It can also overwrite that run's working file with a stale STOPPED snapshot. The live runner keeps executing without a lock, because its heartbeat silently no-ops when the file is gone. The dashboard shows the run as stopped, and a later `acquireLock` can start a second runner on the same lineage.

## Steps to Reproduce

1. Leave a lineage with a stale `runner.json` (dead PID, or a heartbeat older than 30 s) whose run file has `_runtime.executionState = running`, for example by killing the extension host mid-run.
2. In window B, resume or continue that lineage. `WorkflowLockManager.acquireLock` reclaims the stale lock under `withFileLock` and exclusively creates a new `runner.json` with a new `ownerToken`.
3. At the same time, open window C (or restart its extension host). `ExternalRunWatchCoordinator.setupExternalRunWatching` (`src/core/orchestration/ExternalRunWatchCoordinator.ts:182`) calls `normalizeStaleLocks` over all lineages.
4. Interleave so that C's `readWorkflowLockInspection` (`WorkflowLockManager.ts:290`) still sees the old lock as stale, and B's unlink-and-create of the lock happens before C's unlink at line 336. A deterministic test can do this by stubbing `fs.promises.rename` on the run-file `.tmp` so that `acquireLock` runs between the inspection and the unlink.
5. Observe that B's `runner.json` is gone and the run file shows `executionState = stopped` with settled steps, while B is still executing. B's `updateHeartbeat` silently no-ops, and a third `acquireLock` on the lineage succeeds.

## Root Cause

`src/utils/WorkflowLockManager.ts:290-346`. `normalizeStaleLocks` decides staleness once, from `readWorkflowLockInspection` (line 290). It then unlinks `runner.json` (line 336) without holding the `withFileLock` mutex that `acquireLock` (line 95), `releaseLock` (line 154) and `updateHeartbeat` (line 191) all use. It also never re-reads the lock to confirm that the `ownerToken` it judged stale is still the one on disk. The comment at line 334 says there is "no live owner token to check against", but `lockInspection.lock.ownerToken` is available.

This breaks the invariant that a stale actor never touches a successor's lock, which `releaseLock` (lines 157-162) and `updateHeartbeat` (lines 194-199) both enforce.

The run-file overwrite at lines 313-325 is a blind write of a snapshot read at line 274, again with no mutex and no re-validation. It uses a fixed `runFilePath + ".tmp"` name (line 318) that concurrent normalizers in different windows share, and it bypasses the `RunStateWrites` retry path.

`updateHeartbeat` (lines 192-193) treats a missing lock as a silent no-op, so the dispossessed runner never notices the loss.

## Suggested Fix

- Do the stale cleanup for each lineage inside `withFileLock(lockPath, ...)`. Inside the mutex, re-read the lock, confirm it is still stale (with the same `isOwnerStale` / `hasNewerSchema` checks that `acquireLock` uses), and confirm its `ownerToken` equals the token observed at inspection. Only then rewrite the run file and unlink.
- Factor out one helper, for example `reclaimIfStale(lockPath, expectedToken)`, and have both `acquireLock` and `normalizeStaleLocks` use it.
- Write the run file through the shared `RunStateWrites`/atomic-write helper with a unique tmp name, not the hand-rolled `.tmp` plus rename.
- Consider having `updateHeartbeat` report "lock lost" when the file is missing or its owner token differs, instead of no-oping silently, so a runner whose lock disappeared can stop or re-acquire.
- Add a test that injects an `acquireLock` between the inspection and the unlink, and asserts that the successor's lock and run state survive.
