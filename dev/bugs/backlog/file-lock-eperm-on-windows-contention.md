# File lock acquisition throws EPERM under contention on Windows

- **Found:** 2026-09-26 by claude-cli (coordination bug-fixing review pass) during `npm test`
- **Area:** `src/utils/FileLockUtils.ts` (`acquireLock`)
- **Severity:** low: intermittent failure of concurrent first-use callers on Windows; seen as a flaky test

## Symptom

`WebPushService > returns one stable public key when first-use servers initialize concurrently`
failed intermittently in `npm test`:

```text
Error: EPERM: operation not permitted, open '...\notifications\vapid-keys.json.lock'
    at acquireLock (out/utils/FileLockUtils.js)
    at withFileLock (out/utils/FileLockUtils.js)
    at WebPushService.getPublicKey (out/server/WebPushService.js)
```

## Steps to Reproduce

1. On Windows, call `withFileLock` on the same lock path from several concurrent callers. For
   example, run `WebPushService.getPublicKey()` from four fresh instances under `Promise.all`.
2. Sometimes one caller rejects with `EPERM` instead of waiting its turn.

## Root Cause

`acquireLock` retries only when `fs.open(lockPath, "wx")` fails with `EEXIST`. On Windows, opening
a file that another holder has just unlinked but not yet fully deleted (the delete-pending state)
fails with `EPERM`, and sometimes `EACCES`, instead of `EEXIST`. That error is rethrown, so the
caller fails. It should instead treat it as "the lock is still held" and retry.

## Suggested Fix

In `acquireLock`, treat `EPERM`/`EACCES` from the exclusive open like `EEXIST`: sleep for
`LOCK_RETRY_DELAY_MS` and retry until the timeout. Keep rethrowing any other codes. Add a unit test
that stubs `fs.open` to fail once with `EPERM` and asserts that the lock is still acquired.
