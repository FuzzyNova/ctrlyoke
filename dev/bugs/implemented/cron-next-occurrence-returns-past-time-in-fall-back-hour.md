# Cron next-occurrence returns a past time during the repeated fall-back hour

- **Found:** 2026-11-12 by the bug-hunt workflow's final step (claude-cli)
- **Area:** `src/utils/CronSchedule.ts` (`nextCronOccurrence`), `src/core/orchestration/WorkflowScheduler.ts`
- **Resolution:** fixed in this commit

## Symptom

When `afterMs` falls in the second (standard-time) copy of the repeated hour on a
fall-back day, `nextCronOccurrence` returns a time up to an hour *before* `afterMs`.
For example, with `TZ=America/New_York` and `afterMs` = 2026-11-01 01:15 EST
(`2026-11-01T06:15:00Z`):

| Expression      | Returned                         |
| --------------- | -------------------------------- |
| `*/5 * * * *`   | `2026-11-01T05:20:00Z` (01:20 EDT, 55 min in the past) |
| `30 1 * * *`    | `2026-11-01T05:30:00Z` (01:30 EDT, 45 min in the past) |

The function's contract is "the next matching minute after `afterMs`".

The scheduler then spins. `WorkflowScheduler.armFromDescriptor` (at startup or after a
refresh) and the late path of `onWake` both call `nextScheduleOccurrence(schedule, now)`.
They get a past time, `arm()` clamps the delay to 0, and `onWake` sees the occurrence as
more than 60 s late. It writes `scheduleLastMissedAt`/`scheduleNextRunAt` to `workflow.json`,
recomputes from `now`, gets a past time again, and re-arms with delay 0. The result is a
zero-delay loop of descriptor writes that lasts until the wall clock leaves the repeated
hour, and the schedule never fires during that hour.

## Steps to Reproduce

1. `TZ=America/New_York`; bundle `src/utils/CronSchedule.ts` and call
   `nextCronOccurrence("*/5 * * * *", Date.parse("2026-11-01T06:15:00Z"))`.
2. The result is `2026-11-01T05:20:00Z`, which is earlier than the input.
3. In the product: start VS Code (or `ctrlyoke server`) between 01:00 and 02:00 standard
   time on a fall-back day with any cron schedule enabled. The scheduler loops on
   descriptor writes.

## Root Cause

`nextCronOccurrence` normalizes the cursor with `cursor.setSeconds(0, 0)`
(#selection:src/utils/CronSchedule.ts:108-115). Local-time setters re-resolve the local
wall time, and ECMAScript resolves an ambiguous local time to the *earlier* instant (the
daylight-time copy). So a cursor at 01:15 EST becomes 01:15 EDT, an hour earlier, before
the search starts. Later steps (`setMinutes(+1)`) then walk forward from the EDT copy and
return the first match there, which is before `afterMs`.

## Suggested Fix

Truncate to the minute with absolute arithmetic instead of a local setter, e.g.
`const cursor = new Date(Math.floor(afterMs / 60_000) * 60_000 + 60_000)`. Never return
a candidate `<= afterMs`: if the local-setter stepping lands on or before `afterMs`,
advance by absolute minutes (`+60_000`) until it is past it. Keep the existing
"repeated hour runs once" behavior for searches that start before the fall-back hour.
Add `src/test/unit/CronSchedule.test.ts` cases (the suite already pins
`TZ=America/New_York`) asserting that the result is always `> afterMs` for `afterMs` in
both copies of the repeated hour. Also add a scheduler test, or an `onWake` guard, so a
past `nextAt` can never re-arm a zero-delay timer.
