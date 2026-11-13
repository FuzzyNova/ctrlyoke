# A scheduled fire in flight overwrites a schedule edited meanwhile and fires at the old time

- **Found:** 2026-11-12 by the bug-hunt workflow's final step (claude-cli subagent), reproduced with a bundled `WorkflowScheduler` and fake timers
- **Area:** `src/core/orchestration/WorkflowScheduler.ts` (`onWake`)
- **Resolution:** fixed in this commit

## Symptom

A daily `0 9 * * *` schedule fires on Jan 1 at 09:00. While `fire` is still pending (it
loads, seeds and prepares the run, which can take seconds), the user changes the schedule
to `0 17 * * *`. `handleSetSchedule` → `refresh()` correctly arms Jan 1 17:00. Then the
stale wake resumes:

- it writes `scheduleNextRunAt` = Jan 2 09:00, the old schedule's next time;
- `arm()` clears the fresh 17:00 timer, because one timer per lineage means the last caller wins;
- at Jan 2 09:00 `onWake` re-reads the *new* schedule, sees `now >= scheduledAt`, and fires
  at a time the new schedule doesn't contain.

Jan 1 17:00 never runs. The overlap path, the fire-failure path and the late path have the
same problem (`writeNextMetadata` + `arm` with the captured `nextAt`).

## Steps to Reproduce

1. In `src/test/unit/WorkflowScheduler.test.ts` terms: arm a `0 9 * * *` schedule, advance
   to the occurrence, and make `fire` a deferred promise.
2. While it is pending, change the descriptor's schedule to `0 17 * * *` and call `refresh()`.
3. Resolve `fire`. The descriptor's `scheduleNextRunAt` is now the next 09:00, and the only
   armed timer targets it.

## Root Cause

`onWake` computes `nextAt` from the `schedule` it read before `await this.options.fire(...)`
(#selection:src/core/orchestration/WorkflowScheduler.ts:150-209). After the `await` it writes
that `nextAt` and re-arms without checking that the schedule is unchanged. The one-shot
deletion branch already guards against this race (`current.schedule.trigger.at === schedule.trigger.at`),
but the next-run write and the re-arm don't.

## Suggested Fix

Keep a per-lineage generation counter that `refresh()`/`armFromDescriptor()`/`clearTimer`
bump. Capture it at the start of `onWake`, and after every `await` skip the metadata write
and `arm()` if it has changed. Alternatively, have each metadata mutator compare
`current.schedule` with the captured `schedule` and leave the descriptor alone if they
differ (then `refresh()` instead of `arm()`). Cover the success, overlap, failure and late
paths with tests.
