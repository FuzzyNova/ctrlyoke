# Cancelling a pause mid-group can permanently skip members that haven't started

- **Found:** 2026-09-29 by bug-hunt final step (claude-cli)
- **Area:** `src/core/ParallelGroupRun.ts` (`drainWorkers` / `run`)
- **Resolution:** fixed in this commit

## Symptom

A group has members that haven't started (width smaller than the member
count). The user pauses while a member runs, then cancels the pause
(PAUSING → RUNNING) just as that member settles. The group can then join
without running the remaining members: `currentIndex` moves to
`endIndex + 1`, the unstarted members stay pending forever, and the group stays
in `CLOSING` admission.

## Steps to Reproduce

Reproduced with a temporary mocha test against `ParallelGroupRun`: width 1,
members `A` and `B`, and `getRuntimeStatus` backed by a mutable variable.

1. Start `run()`. Once `A` is executing, set status to `PAUSING` and release `A`.
2. In `persistAdmission` (the async CLOSING write), await briefly, then flip
   status back to `RUNNING` (simulating Cancel Pause landing during the write).
3. Observed: executed `['A']`, `commitJoin` receives 1 outcome, and
   `paused: false`. Expected: executed `['A','B']` and 2 outcomes.

## Root Cause

In `drainWorkers`, the paused branch awaits `closeAdmission()` (an async
working-file write), then returns because `isDrained()` is true (no active
workers). Back in `run()`, `isPaused()` is now false, so it skips the pause
return and goes straight to `reconcileAndClose` / `commitJoin`. The pending
members are already known IDs, so reconciliation admits nothing new, and the
join commits with `nextPending < pendingIds.length`.

## Suggested Fix

In `run()`, before reconciling or committing the join, if the run is neither
stopped nor failed fast and `nextPending < pendingIds.length`, loop back to
`drainWorkers()` so the remaining members are dispatched. Alternatively,
re-check `isPaused()` in `drainWorkers` after `closeAdmission()` and fall through
to `startAvailableWorkers()` when the pause was cancelled. Think about whether
admission should reopen after a cancelled pause. Add a `ParallelGroupRun` unit
test for the scenario above.
