# A schedule owned by another synced machine is evaluated in this machine's timezone

- **Found:** 2026-11-13 by claude-cli while fixing `hosted-schedule-preview-uses-browser-timezone`
- **Area:** `src/types/CtrlYokeTypes.ts` (`WorkflowSchedule`), `src/ui/webview-react/utils/workflowScheduleDisplay.ts`
- **Severity:** low

## Symptom

With a synced state home, only the machine named by a schedule's `hostId` fires it, at
its own wall-clock time. Another machine sharing that history shows the schedule
(`scheduleOnOtherHost`), but its dashboard computes and shows the next run in _its own_
timezone. The owner never writes `scheduleNextRunAt` into a form the viewer can use: it
is absent for a schedule armed elsewhere, so `upcomingScheduleRunAt` falls back to
evaluating the trigger with the viewing host's `hostTimeZone`. A laptop in Los Angeles
looking at a desktop-in-New-York schedule for 09:00 shows 9:00 AM PT; it fires at 6:00 AM PT.

## Steps to Reproduce

1. Put the ctrlyoke state home in a synced folder on two machines in different timezones.
2. Schedule a workflow daily at 09:00 on machine A.
3. Open the dashboard on machine B and read the Scheduled section's next run.

## Root Cause

`WorkflowSchedule` stores wall-clock times and a `hostId`, but not the owner's
timezone, so no other machine can know which zone the times are in.

## Suggested Fix

Store the owner's IANA zone on the schedule when it is saved (an optional `timeZone`,
set from `localTimeZone()` in `WorkflowLibraryHandlers`' `SET_SCHEDULE` handler), and
evaluate a schedule in `schedule.timeZone ?? hostTimeZone` on the client. Decide
whether the host should also fire in the stored zone (changes the documented meaning
"local timezone of the machine running ctrlyoke") or keep firing in its process zone and
only use the field for display. `workflow.json` carries a `schemaVersion`, so follow
the persisted-state rules in `CLAUDE.md` for the new field.
