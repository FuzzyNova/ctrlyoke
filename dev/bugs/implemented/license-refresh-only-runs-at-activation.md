# Pro license auto-refresh only runs once, at extension activation

- **Found:** 2026-09-30 by the bug-backlog workflow final step (claude-cli)
- **Area:** `src/license/LicenseService.ts` (`refresh`), `src/extension.ts` (~251)
- **Resolution:** fixed in this commit

## Symptom

`dev/implemented/PRO_LICENSE_PLAN.md` promises that an online license file (30-day
TTL) gets "silent background auto-refresh whenever the machine is online".
In fact `licenseService.refresh()` is called from exactly one place,
`src/extension.ts:251`, once during activation. `refresh()` only does anything
between `issuedAt + TTL - LICENSE_REFRESH_LEAD_MS` and
`issuedAt + TTL + LICENSE_OFFLINE_GRACE_MS` (day 23 to day 44).

So:

- A VS Code window that stays open (the normal setup for the always-on remote
  dashboard) never refreshes. `getEntitlement()` re-verifies the cached file every
  60 s and drops to free on day 44, gating remote bind and push, while the
  user may be away from the machine.
- If the machine is offline (or Keygen is unreachable) during the one
  activation-time attempt, nothing retries until the next restart.

## Steps to Reproduce

1. Activate Pro online on day 0.
2. Keep the same VS Code window open past day 44 (or use a fake clock in a
   `LicenseService` test that advances `now` without calling `refresh()` again).
3. The entitlement drops to free, and no checkout request was ever sent after
   day 23.

## Root Cause

No timer or retry schedules `refresh()`. The existing tests cover "don't refresh
outside the window" but not when refresh is scheduled.

## Suggested Fix

Have `LicenseService` own a refresh schedule: after activation, call `refresh()`
on an interval (e.g. every 6 hours; the window is 21 days wide, so a coarse
cadence is enough) and retry sooner (with backoff) after a failed attempt inside
the window. Unref the timer and clear it on `dispose()`, and register the service
(or a disposable wrapping the timer) in `context.subscriptions`. Keep `refresh()`
idempotent and guarded against overlapping runs. Unit test with an injected clock
and timer: advancing into the refresh window without re-activating triggers a
checkout, and a failed checkout is retried.
