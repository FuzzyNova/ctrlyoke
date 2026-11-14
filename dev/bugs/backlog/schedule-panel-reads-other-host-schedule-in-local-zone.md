# Schedule view reads another machine's schedule in this machine's timezone

- **Found:** 2026-11-13 by the bug-hunt workflow final step (claude-cli), reviewing 2bee7ffff and c1ee66dac
- **Area:** `src/ui/webview-react/components/workflow/SchedulePanel.tsx`
- **Severity:** low (low confidence; may be a design gap)

## Symptom

Say a schedule is owned by a machine in `Asia/Tokyo` (its `timeZone` is
recorded) and is viewed from a machine in `America/New_York` that shares the
state home:

- The workflow list's Scheduled row shows the correct next run, 09:00 Tokyo
  (7:00 PM New York), through `ownerScheduleCalendar`.
- Opening the Schedule view for the same unedited schedule shows 09:00 and
  "Next run: 9:00 AM", which is New York time.
- Ticking **Pause** and saving keeps "09:00", but now in New York time. The
  fire time moves by 14 hours without the user changing a time.
- A **Once** time that exists in Tokyo but falls in New York's spring-forward
  gap fails validation, and Save is disabled for an unedited, valid schedule.

## Steps to Reproduce

1. Save a schedule on host A (zone A). Open the same lineage on host B (zone
   B ≠ A) with shared state.
2. Compare the Scheduled row's next run with the Schedule view's pickers and
   "Next run" preview.

## Root Cause

`SchedulePanel` builds `pickerFor`, validation and the preview from
`scheduleCalendar(hostTimeZone)` and ignores `schedule.timeZone`. The list
views use the owner's zone. `docs/guide/dashboard.md` says other machines read
a schedule's times in the owner's zone.

## Why it may be intended

Saving on another host re-owns the schedule. The panel says "Scheduled on
another machine; saving here moves it.", and the cron hint says "in this
machine's time", so the preview arguably shows the result after saving.

## Suggested Fix

When the schedule belongs to another host and has a `timeZone`, do one of
these:

- convert its wall-clock values into this host's zone when loading the pickers;
- say in the panel that it currently runs in `<zone>` and that saving
  reinterprets the times in this machine's zone.

Either way, preview an untouched schedule through `ownerScheduleCalendar`.
