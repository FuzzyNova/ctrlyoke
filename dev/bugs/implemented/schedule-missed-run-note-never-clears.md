# The schedule's "missed run" note never clears for recurring schedules, even after a re-save

- **Found:** 2026-11-12 by the bug-hunt workflow's final step (claude-cli subagent), from code reading
- **Area:** `src/ui/WorkflowLibraryHandlers.ts` (`handleSetSchedule`), `src/core/orchestration/WorkflowScheduler.ts` (`onWake`)
- **Resolution:** fixed in this commit

## Symptom

After one missed occurrence (ctrlyoke closed or asleep for more than 60 s past a run time),
the Schedule view shows "A scheduled run was missed while ctrlyoke was not running."
(`SchedulePanel.tsx`, shown whenever `scheduleLastMissedAt !== undefined`). The note stays
forever:

- after any number of later successful runs;
- after the user edits and saves the schedule, including replacing it with a new one-shot.

Only **Remove schedule** clears it.

## Steps to Reproduce

1. Schedule a workflow daily.
2. Keep ctrlyoke closed past one occurrence, then start it. `armFromDescriptor` writes
   `scheduleLastMissedAt`.
3. Let the next occurrence fire successfully, or save a changed schedule.
4. Reopen the Schedule view. The missed note is still there.

## Root Cause

- `handleSetSchedule`'s descriptor mutator deletes `scheduleNextRunAt` but not
  `scheduleLastMissedAt` (#selection:src/ui/WorkflowLibraryHandlers.ts:1388-1396).
- The scheduler's success write sets `scheduleLastRunAt` and deletes
  `scheduleLastMissedAt` only inside the one-shot branch
  (#selection:src/core/orchestration/WorkflowScheduler.ts:182-199).

## Suggested Fix

Delete `scheduleLastMissedAt` in `handleSetSchedule`'s mutator and in the scheduler's
success write for every trigger kind. A successful run supersedes the earlier miss. Add
assertions to `src/test/unit/WorkflowLibraryHandlers.test.ts` (set schedule clears it) and
`src/test/unit/WorkflowScheduler.test.ts` (a successful recurring fire clears it).
