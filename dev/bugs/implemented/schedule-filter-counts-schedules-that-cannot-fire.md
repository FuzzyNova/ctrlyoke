# Workflow dropdown's schedule filter counts schedules that can never fire again

- **Found:** 2026-11-12 by the bug-hunt workflow's final step (claude-cli subagent), confirmed with a throwaway Vitest
- **Area:** `src/ui/webview-react/components/workflow/WorkflowSwitcher.tsx` (`workflowMatchesSearch`)
- **Resolution:** fixed in this commit

## Symptom

A lineage with a schedule that has no run left to come is shown in **Recent
workflows**, not **Scheduled**, which is correct. But the Scheduled / Not scheduled
filter still treats it as scheduled:

- Filter to **Not scheduled** only: the row disappears.
- Filter to **Scheduled** only: it appears in the Recent list while the Scheduled section
  is absent.

Affected schedules: `until` in the past (e.g. `{ enabled: true, trigger: { cron: "0 9 * * *" }, until: "2020-01-01T00:00" }`),
and a paused one-shot whose `at` has passed (the scheduler deletes a one-shot only after
it fires, so a paused one keeps its schedule).

## Steps to Reproduce

1. Give a workflow `schedule: { enabled: true, trigger: { cron: "0 9 * * *" }, until: "2020-01-01T00:00" }`.
2. Open the workflow dropdown; it appears under Recent workflows.
3. Open the filter, untick **Scheduled**: the row vanishes although it is listed as not
   scheduled.

## Root Cause

`workflowMatchesSearch` computes `isScheduled` as `Boolean(workflow.schedule ?? …)`
(#selection:src/ui/webview-react/components/workflow/WorkflowSwitcher.tsx:1525-1531),
while the section split uses `upcomingScheduleRunAt(recentWorkflow, scheduleNow) !== null`
(#selection:src/ui/webview-react/components/workflow/WorkflowSwitcher.tsx:1602-1606).
The docs say Scheduled "lists workflows whose schedule has a run still to come", and
40a907293 deleted fired one-shots precisely so they stop reading as scheduled "in the
main list and the Scheduled filter".

## Suggested Fix

Base `isScheduled` on `upcomingScheduleRunAt(lineage, scheduleNow) !== null` for the
matching recent lineage (running rows already look theirs up in `sortedRecentWorkflows`).
Add a Vitest in the workflow-switcher tests: an expired-`until` schedule is shown with the
Not scheduled filter only and hidden with the Scheduled filter only.
