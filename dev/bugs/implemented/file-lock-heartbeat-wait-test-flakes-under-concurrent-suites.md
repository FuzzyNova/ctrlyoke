# FileLockUtils "waits past timeout while a holder heartbeat stays fresh" flakes under `npm test`

- **Found:** 2026-11-01 by Claude Code (claude-cli) while running `npm test` for template changes
- **Area:** `src/test/unit/FileLockUtils.test.ts`, `src/utils/FileLockUtils.ts`
- **Resolution:** fixed in this commit

## Symptom

The extension suite fails with one test in two consecutive full `npm test` runs on Windows
(`.ctrlyoke/logs/test-runs/npm-test-2026-11-01T23-33-10-497Z.log` and
`npm-test-2026-11-01T23-48-52-790Z.log`):

```
FileLockUtils
  withFileLock
    1) waits past timeout while a holder heartbeat stays fresh:
  FileLockTimeoutError: Timed out waiting for lock: ...\cy-lock-<id>.json.lock
    at acquireLock (out/utils/FileLockUtils.js:190:11)
    at async withFileLock (out/utils/FileLockUtils.js:255:24)
    at async Promise.all (index 1)
```

`index 1` is the waiter. Re-running the suite alone passes.

## Steps to Reproduce

1. On Windows, run `npm test`, which runs the extension, UI and packaging suites at the same time.
2. Sometimes the test above fails with `FileLockTimeoutError`. It passes when run alone.

To reproduce it on demand, take the test's setup (a holder with `staleMs: 120`, then a
waiter with `timeoutMs: 80` and `waitWhileHolderAlive`) and busy-wait the event loop for
150 ms right after the waiter starts. In 20 runs with no stall, all 20 passed. With the stall,
the waiter threw `FileLockTimeoutError` in half the runs or more.

## Root Cause

The test's stale window was too small for a loaded machine. The holder's heartbeat is a
`setInterval` at `staleMs / 3` on the same event loop as the waiter, and staleness is wall-clock
time against the lock's mtime. So any stall longer than about 120 ms made the live holder look
stale. A traced repro showed the waiter's first `stat` 150 ms after the stall began, seeing the
lock 152 ms old. From there the waiter took one of two paths. Both were bugs in `acquireLock`, not
only in the test:

1. **The reclaim succeeded, then the waiter gave up.** The waiter renamed the lock away and
   confirmed it was the same file it had judged stale. Then it deleted the lock and
   `continue`d to the top of the loop. By then `timeoutAt` had passed and `sawLiveHolder` was
   false, so it broke out and threw `FileLockTimeoutError` without trying to create the lock it
   had just freed. This happens to any waiter whose timeout runs out during its own reclaim
   round trips.
2. **The lock changed during the reclaim, and the waiter did not count that as a live holder.**
   The late heartbeat touched the lock between the waiter's `stat` and its `rename`, so the
   renamed file no longer matched. The waiter restored the lock "as though it were held" but
   never set `sawLiveHolder`. In wait mode it then gave up at `timeoutMs` on a lock that was
   provably in use.

## Fix

- `acquireLock` allows one more attempt to create the lock right after it removes a stale one,
  even if the timeout has passed (`reclaimedStaleLock`).
- `acquireLock` sets `sawLiveHolder` when the lock changed during a reclaim, so wait mode keeps
  waiting.
- The heartbeat tests use a 1.5 s stale window (`HEARTBEAT_STALE_MS`) and keep the lock for 2 s.
  That still proves the heartbeat keeps the lock fresh, and tolerates about a second of stall
  instead of about 120 ms. "default timeout still expires while a fresh holder is active" uses the
  default stale window, since it tests the timeout, not liveness.
- New deterministic tests cover each `acquireLock` path, using injected `stat`: "takes a stale
  lock it reclaimed after its timeout passed" and "wait mode keeps waiting after restoring a
  lock that changed during reclaim". Each one fails without its fix.
