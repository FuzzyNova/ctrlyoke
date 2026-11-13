# The hosted Schedule view previews and validates times in the browser's timezone, not the host's

- **Found:** 2026-11-12 by the bug-hunt workflow's final step (claude-cli subagent), from code reading
- **Area:** `src/ui/webview-react/components/workflow/SchedulePanel.tsx`
- **Severity:** low

## Symptom

`docs/guide/dashboard.md` says schedule times use the local timezone of the machine running
ctrlyoke. The Schedule view computes its **Next run** preview, its "never runs" check and its
default Once value with `nextScheduleOccurrence`/`parseLocalDateTime`, which run in the
_browser's_ zone. Take a host in New York and a hosted-dashboard browser in Los Angeles:

- the preview for Once 09:00 says 9:00 AM;
- the host fires at 09:00 New York time, which is 06:00 in Los Angeles;
- after saving, the Scheduled list (from the host's `scheduleNextRunAt`) shows 6:00 AM;
- a one-shot that is future in host time but past in browser time (or the reverse) is
  wrongly refused or accepted.

## Steps to Reproduce

1. Run `ctrlyoke server` with `TZ=America/New_York`.
2. Open the hosted dashboard in a browser set to `America/Los_Angeles`.
3. Schedule a Once run and compare the preview with the saved next run.

## Root Cause

The preview runs the shared schedule helpers client-side (`SchedulePanel.tsx` around
the `previewSchedule`/`neverRuns` computations). Those helpers use the JS local zone, and
the host's zone is never sent to the client.

## Suggested Fix

**Needs a design decision.** Either send the host's IANA zone (or UTC offset) with the
recent-workflows payload and compute the preview in it, or have the host compute the preview
and label times as host time. Neither is a one-line change: the shared helpers use the
process-local `Date` API.
