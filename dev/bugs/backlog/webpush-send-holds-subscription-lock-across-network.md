# Web push send holds the subscription file lock across network fan-out

- **Found:** 2026-10-02 by bug-hunt final step (source review + lock-timeout repro)
- **Area:** `src/server/WebPushService.ts`
- **Severity:** medium

## Symptom

`WebPushService.sendNotification` holds the cross-process `withFileLock` on
`push-subscriptions.json` while it sends one sequential `fetch` to every
subscribed push endpoint, and none of those fetches has a timeout. The file
lives under `ctrlyokeStateHome()`, so every VS Code window or CLI with a
hosted server shares it.

- If one window's fan-out takes longer than `LOCK_TIMEOUT_MS` (5s), another
  window's `sendNotification`, `upsertSubscription`, `removeSubscription` or
  `listSubscriptions` throws `FileLockTimeoutError`. Its notification is
  dropped (only a `Log.warn`), or the hosted subscribe request returns 500.
  A slow endpoint alone can cause this, since undici's default connect timeout
  is 10s per subscription.
- If the fan-out takes longer than `LOCK_STALE_MS` (30s), the other process
  takes over the "stale" lock and writes, for example a new subscription. The
  first process then writes the `survivors` array it built from its earlier
  read. That silently erases the new subscription, or brings back one that was
  removed in the meantime.

## Steps to Reproduce

1. Hold `withFileLock(<state>/notifications/push-subscriptions.json)` in one
   process for 7s (simulating a slow push fan-out).
2. In a second process, call `withFileLock` on the same path.
3. Observe `FileLockTimeoutError` after about 5s (reproduced: 5016 ms).

## Root Cause

`sendNotification` (`src/server/WebPushService.ts`, about lines 204–301) wraps
read → network sends → write in a single `withSubscriptionFileLock`. The lock
is meant to serialise short read-modify-write operations across processes:
`FileLockUtils` uses a 5s acquire timeout, a 30s stale threshold, and no
heartbeat.

## Suggested Fix

- Read the registry under the lock, then release it.
- Send outside the lock, with `AbortSignal.timeout(...)` on every `fetch`.
- Re-acquire the lock, re-read the registry, and merge the results by
  `endpointHash`. Drop entries that returned 404/410, update the
  success/failure fields on entries that still exist, and keep entries added
  meanwhile untouched.
