# FileLockUtils "waits past timeout while a holder heartbeat stays fresh" flakes under `npm test`

- **Found:** 2026-11-01 by Claude Code (claude-cli) while running `npm test` for template changes
- **Area:** `src/test/unit/FileLockUtils.test.ts`, `src/utils/FileLockUtils.ts`
- **Severity:** low

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

`index 1` is the waiter. Re-running the suite alone
(`MOCHA_GREP='FileLockUtils|TemplateManager' npm run test:extension`) passes. The change under
test only touched workflow template YAML, docs and `TemplateManager.test.ts`, so it does not
affect file locking.

## Steps to Reproduce

1. On Windows, run `npm test`, which runs the extension, UI and packaging suites at the same time.
2. Sometimes the test above fails with `FileLockTimeoutError`. It passes when run alone.

## Root Cause

Likely, not confirmed. The test runs with very small margins (`FileLockUtils.test.ts:151-183`):
`staleMs: 120`, so the holder heartbeat fires every 40 ms (`staleMs / 3`, `FileLockUtils.ts:273-282`),
and the waiter uses `timeoutMs: 80`. In `acquireLock` (`FileLockUtils.ts:101-104`), the waiter
can only keep waiting past `timeoutAt` if one of its `stat` calls has already seen a fresh
heartbeat (`sawLiveHolder`, set at line 132). When the other suites load the CPU and disk,
the holder's `setInterval` heartbeat (same process, same event loop) can slip past 120 ms.
In that window the waiter's first `stat` finds the lock stale instead of live. The stale
reclaim then sees the mtime changed by the late heartbeat and restores the lock (lines 159-173)
without setting `sawLiveHolder`. A `stat` error other than ENOENT (line 180) also leaves it unset.
By then 80 ms have passed, so the next iteration exits the loop and throws `FileLockTimeoutError`
(line 192).

## Suggested Fix

Widen the test's margins so normal load from the other suites cannot make the holder look
stale. For example, use `staleMs: 1_000` and `timeoutMs: 200`, keep `maxWaitMs` well above the
holder's hold time, and make the 300 ms "still waiting" sleep larger than `timeoutMs` but smaller
than `maxWaitMs`. If the restore path at lines 159-173 should count as evidence of a live holder
(the pathname changed because the holder refreshed it), also set `sawLiveHolder = true` there.
That is a behavior change to the lock, so it should get its own test.
