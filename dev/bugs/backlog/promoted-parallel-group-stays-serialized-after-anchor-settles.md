# Promoted parallel group stays serialized after its adopted anchor settles

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/core/ParallelGroupRun.ts`
- **Severity:** low

## Symptom

A group that starts by promoting around a running sequential step does not use the slot the anchor frees. Members queued while the anchor was running run one at a time after it finishes, even with a worker slot free. They only fan out to `maxParallelSteps` after the current worker has emptied the queue.

## Steps to Reproduce

1. Enable parallel-group fan-out and set `maxParallelSteps` to 2.
2. Start a workflow. While step A runs sequentially, use Run in Parallel to add step B to A's group. The group is promoted, A is adopted and holds 1 of the 2 slots, and B starts on the single worker.
3. While A and B are still running, use Run in Parallel to add step C. C is admitted and queued, which is correct because both slots are taken.
4. Let A finish while B keeps running.
5. Observed: C stays pending until B completes. Expected: C starts as soon as A frees its slot and runs beside B.

## Root Cause

- `settleAdoptedMember` (`src/core/ParallelGroupRun.ts:192-213`) removes the anchor from `adopted`. That raises `effectiveWorkerWidth()` (lines 468-470) from 1 to 2, but the method only calls `releaseAdoptionWaiter()` (line 200) and never starts a worker for the freed slot.
- `drainWorkers` (lines 388-417) calls `startAvailableWorkers()` only on entry (line 389) or when `activeWorkers === 0` (lines 403-404). Between those points it waits on `await Promise.all(outstanding)` (line 415), and `outstanding` includes the live worker's promise.
- That worker (lines 380-386) keeps pulling from `pendingIds` until the queue is empty. The drain loop therefore does not run again until every queued member has finished.
- `admit()` (lines 233-236) checks the width only when a member is admitted. Members queued before the anchor settled never get their own worker. Only a member admitted after the anchor settles gets one.

## Suggested Fix

- In `settleAdoptedMember`, after `releaseAdoptionWaiter()`, call `this.startAvailableWorkers()` when `runStarted` is true and fail-fast has not been triggered. Either put the call ahead of the fail-fast branch guarded by `!this.failFastTriggered`, or put it in an `else` of that branch. The freed slot then dispatches queued members right away.
- Alternative: have `drainWorkers` wait with `Promise.race(outstanding)` and call `startAvailableWorkers()` on every pass. Then any settlement, whether a worker's or an adopted member's, re-checks capacity.
- Add a regression test to `ParallelGroupRun.test.ts` with width 2, an adopted anchor, and pending `["one", "two"]`. Settle the anchor while `"one"` is still blocked, then assert that `"two"` starts before `"one"` is released.
