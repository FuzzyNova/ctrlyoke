# Two waiters can both break the same stale lock, and the second deletes the fresh lock the first just took

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/utils/FileLockUtils.ts`
- **Severity:** low

## Symptom

After a stale lock is broken, two processes can be inside the same `withFileLock` critical section at the same time. Their read-modify-write of the protected JSON file (for example `<run>/workflow.json`, a usage store, or the execution-root lease arbitration target) interleaves, and one update is silently lost. The first holder's release can also delete the second holder's lock, which lets further waiters into the overlap.

## Steps to Reproduce

1. Create `<target>.lock` with a payload and backdate its mtime by 60 s to simulate a holder that crashed.
2. Start two processes that call `withFileLock(<target>, ...)` at the same time. In a unit test, use two calls with injected ops that pause waiter B between `fs.stat` and `rename`.
3. Waiter A stats the lock, judges it stale, calls `removeLockFile`, loops, creates a fresh lock with `open('wx')`, and writes its payload.
4. Resume B. It already judged the old lock stale, so its `removeLockFile` renames A's fresh lock to B's tombstone and unlinks it.
5. B loops, `open('wx')` succeeds, and B enters the action while A is still inside its own. Both read the same JSON and both write it, so A's or B's change is lost.

## Root Cause

`src/utils/FileLockUtils.ts:142-148`: the staleness decision (`fs.stat` at line 143 plus the mtime check against `LOCK_STALE_MS` at line 144) and the removal (`removeLockFile` at line 146, which calls `ops.rename(lockPath, tombstone)` at line 93) form a check-then-act on a path rather than on a specific file. Between the check and the removal, another waiter can break the stale lock and create a new live one at the same path (lines 120-127). `removeLockFile` then removes the live lock. Nothing re-checks that the renamed file is the one that was judged stale (same inode, mtime, or payload).

Releases do not check ownership either. `releaseLock` (line 174) removes whatever file is at `lockPath`, so a holder whose lock was stolen later deletes the thief's lock. The lock's mtime is also never refreshed during a long action, so a live holder that runs past 30 s looks stale to other waiters too.

## Suggested Fix

Make breaking a stale lock verify ownership. First rename the stale lock to a unique tombstone. Then stat or read the tombstone and confirm it is the same file that was judged stale: the same `ino`/`dev`, or the same `mtimeMs` and payload captured in the earlier stat or read. If it is a different file, another waiter took a fresh lock in between. In that case, put it back if the lock path is still free (open-`'wx'`-style, or link it to the original name), or treat the lock as held and retry.

Better still, write a unique token (pid plus `randomUUID`) into each lock instead of the current `pid timestamp` payload (line 122). Release would then remove the lock only when its payload still matches the holder's token. Stale-breaking would compare the token read at judgement time with the token in the renamed tombstone. Consider also refreshing the lock's mtime while a long action runs.

Add a unit test that uses the injectable `open`/`rename` ops to pause waiter B between stat and rename, and asserts that two waiters on one stale lock never run their actions at the same time.
