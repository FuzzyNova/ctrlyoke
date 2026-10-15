# File lock goes stale 30s after it is taken, even while the holder is still working, so long critical sections lose mutual exclusion

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/utils/FileLockUtils.ts`
- **Resolution:** fixed in this commit

## Symptom

Two processes rebuild the history search index for the same project at the same time, for example two VS Code windows, or the extension plus the ctrlyoke CLI. When the first full rebuild runs longer than 30s, the second process treats the first one's lock as stale, removes it and starts its own rebuild alongside. The two then delete each other's `rebuild-<ts>` directories and race on `documents/` and `manifest.json`. The result is `ENOENT` errors in the first rebuild and a missing, partial or mismatched search index (manifest from one rebuild, shards from the other).

When the first holder releases, it also deletes the second holder's lock file, which lets a third waiter in.

## Steps to Reproduce

1. Use a project with a large run history, or a slow or synced state directory, so that a full history-search rebuild takes more than 30s. A schema version bump or deleting the index's `manifest.json` forces a full rebuild.
2. Process A (VS Code window 1) starts a history search, which spawns the rebuild worker. It acquires `<indexDir>/manifest.json.lock` and starts writing shards into `<indexDir>/rebuild-<tsA>/`.
3. Within the next 60s, process B (a second VS Code window on the same project, or `ctrlyoke` CLI history search) also triggers a rebuild. It gets `EEXIST` and polls with `timeoutMs = 60000`.
4. About 30s after A acquired the lock, B's `fs.stat` shows the lock's mtime is older than `LOCK_STALE_MS`. B removes A's lock (`FileLockUtils.ts:142-147`), acquires its own, and starts its own full rebuild in `rebuild-<tsB>/`.
5. Whichever process finishes first runs `cleanupRebuildDirs`, which `rm -rf`s the other process's `rebuild-*` directory (`historySearchRebuildWorker.ts:970-984`). The other process fails with `ENOENT` on its next shard write or rename. Alternatively, the two `swapIndexFiles` calls interleave (lines 942-959), leaving `documents/` and `manifest.json` from different rebuilds, or missing.
6. When A's `withFileLock` `finally` block runs, `releaseLock` deletes B's lock file (`FileLockUtils.ts:174`), so another waiter can get in while B is still working.

## Root Cause

`src/utils/FileLockUtils.ts:9` sets `LOCK_STALE_MS = 30000`, and lines 142-148 decide staleness only from the lock file's mtime (`Date.now() - stats.mtimeMs > LOCK_STALE_MS`). The mtime is set once when the lock is created (lines 120-126) and never refreshed while the action runs (`withFileLock`, lines 184-202). The PID written into the payload (line 122) is never checked. So the age measures time since acquisition, not whether the holder is still alive.

`releaseLock` (lines 169-182) calls `removeLockFile` unconditionally, without checking that the lock file still holds the caller's own payload, so a holder whose lock was stolen deletes the new owner's lock.

The long critical section that exposes this is `runHistorySearchRebuild` in `src/core/orchestration/historySearchRebuildWorker.ts` (lock taken at lines 338-552). It waits with `REBUILD_LOCK_TIMEOUT_MS = 60_000` (line 54) and does a full rebuild under the lock: shard writes (lines 477-522), `swapIndexFiles` (lines 937-960, called at 540) and `cleanupRebuildDirs` (lines 962-989, called at 541).

## Suggested Fix

Make lock liveness explicit and ownership-checked in `FileLockUtils`:

1. Write a unique owner token (pid plus a random UUID) into the lock file. In `releaseLock`, read the file and remove it only if the token is still ours. Tolerate `ENOENT`, and log a warning when the token belongs to someone else, because that means the lock was stolen.
2. Refresh the lock while the action runs, for example with a `setInterval` every `LOCK_STALE_MS / 3` that calls `fs.utimes` on the lock path. Clear the interval in the `finally` block. This keeps a live long holder from ever looking stale.
3. Optionally, before reclaiming a stale-looking lock, parse the payload PID and treat the lock as stale only if that process is dead (`process.kill(pid, 0)` throws `ESRCH`) or the heartbeat is old. This matches how `runner.json` is already reclaimed (dead PID or heartbeat older than 30s).
4. Add a unit test where the holder's action runs longer than `LOCK_STALE_MS` (with a reduced stale window or fake timers), and assert that a concurrent waiter with a longer timeout does not enter the critical section until the holder releases.

Defense in depth in `historySearchRebuildWorker`: make `cleanupRebuildDirs` skip `rebuild-*` directories younger than some threshold, so it never deletes a sibling's in-progress directory.

## Decision

The stale-break path validates both the lock token and file identity after rename; if the path changed, it restores the renamed payload only with exclusive creation and keeps waiting. Rebuild cleanup uses a five-minute age threshold to protect recently active directories.
