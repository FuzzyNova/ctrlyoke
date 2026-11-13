# A schedule owned by another synced machine is evaluated in this machine's timezone

- **Found:** 2026-11-13 by claude-cli while fixing `hosted-schedule-preview-uses-browser-timezone`
- **Area:** `src/types/CtrlYokeTypes.ts` (`WorkflowSchedule`), `src/ui/webview-react/utils/workflowScheduleDisplay.ts`
- **Resolution:** fixed in this commit

## Symptom

With a synced state home, only the machine named by a schedule's `hostId` fires it, at
its own wall-clock time. The owner writes its next run (`scheduleNextRunAt`) into the
synced `workflow.json`, and other machines show that while it is in the future. But:

- When that value is stale (the owner is not running) or absent (the schedule is
  paused, or was just saved), `upcomingScheduleRunAt` evaluates the trigger in the
  _viewing_ machine's timezone. A laptop in Los Angeles showing a desktop-in-New-York
  schedule for 09:00 computes 9:00 AM PT; the owner fires at 6:00 AM PT.
- `WorkflowLineageRepository.readDescriptorFromPath` validates the schedule in the
  reading machine's timezone. A one-shot `at` or an `until` that falls in the
  reader's daylight-saving gap (but exists on the owner's clock) is dropped as invalid,
  and the reader's next descriptor write, such as toggling a favorite, deletes the
  schedule from the synced file.

## Steps to Reproduce

1. Put the ctrlyoke state home in a synced folder on two machines in different timezones.
2. Schedule a workflow daily at 09:00 on machine A.
3. Open the dashboard on machine B and read the Scheduled section's next run.

## Root Cause

`WorkflowSchedule` stores wall-clock times and a `hostId`, but not the owner's
timezone, so no other machine can know which zone the times are in.

## Suggested Fix

Store the owner's IANA zone on the schedule as an optional `timeZone`: set when saved,
and refreshed by the owner's scheduler whenever it arms the schedule (covering older
schedules, paused ones, and a host whose zone changed). Validate a schedule in its own
`timeZone`, and have other machines compute its next run in it. The owner keeps
firing in its process zone, as documented. The field is additive, as the schedule
fields themselves were at lineage descriptor v1, so no format bump.
