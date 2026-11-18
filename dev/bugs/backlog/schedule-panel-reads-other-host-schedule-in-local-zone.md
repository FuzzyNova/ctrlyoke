# Schedule view reads another machine's schedule in this machine's timezone

- **Found:** 2026-11-13 by the bug-hunt workflow final step (claude-cli), reviewing 2bee7ffff and c1ee66dac
- **Area:** `src/ui/webview-react/components/workflow/SchedulePanel.tsx`
- **Severity:** low

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

**Decided 2026-11-18 (Nathan): edit in the owner's zone.**

- When the schedule has a recorded `timeZone`, `SchedulePanel` builds `pickerFor`,
  validation and the "Next run" preview from that zone (the calendar
  `ownerScheduleCalendar` already builds), not from `hostTimeZone`.
- Saving on this host still takes ownership, but keeps the schedule's `timeZone`, so an
  unedited save (for example ticking **Pause**) never moves a fire time and a valid Once
  time never fails validation here.
- Show the zone in the panel when it differs from this machine's ("Times are in
  Asia/Tokyo"), with an explicit action to switch the schedule to this machine's zone.
  Switching reinterprets the wall-clock values in the new zone; say so.
- Change the cron hint from "in this machine's time" to name the schedule's zone.
- The runner must evaluate the schedule in its recorded `timeZone`. **Checked 2026-11-18:
  today it does not, and it actively undoes the zone.** `WorkflowScheduler` calls
  `nextScheduleOccurrence(schedule, …)` with the default `LOCAL_CALENDAR`, and
  `recordOwnerTimeZone` (called from `armFromDescriptor`) overwrites an owned schedule's
  `timeZone` with this host's zone whenever they differ. So a schedule saved here with
  Tokyo's zone would be rewritten to New York's and fire at New York wall-clock times. The
  fix therefore includes:
  - `WorkflowScheduler` computes every occurrence (`armFromDescriptor`,
    `nextOccurrenceFromNow`, `onWake`) with `ownerScheduleCalendar(schedule, <this host's
    zone>)`.
  - `recordOwnerTimeZone` only fills a **missing** `timeZone` (schedules saved before the
    field existed); it no longer overwrites a recorded one. A host whose own zone changed
    keeps firing in the recorded zone, which matches what the panel displays; the panel's
    "switch to this machine's zone" action is the way to move it. Update that method's doc
    comment and the scheduler tests that assert the overwrite.
- Update `docs/guide/dashboard.md` and record the change under **Changed** in
  `CHANGELOG.md`. Vitest cases: unedited save from another zone keeps times and zone; a
  Once time in this host's DST gap but valid in the owner's zone saves; the switch action
  rewrites the zone.
