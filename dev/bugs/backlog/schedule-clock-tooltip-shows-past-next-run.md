# Schedule clock tooltip and menu item can show a next run in the past

- **Found:** 2026-11-12 by the bug-hunt workflow's final step (claude-cli subagent), confirmed with a throwaway Vitest
- **Area:** `src/ui/webview-react/components/workflow/WorkflowRowLayout.tsx` (`ScheduleRowActionButton`), `src/ui/webview-react/hooks/useWorkflowContextMenu.tsx` (Schedule… item)
- **Severity:** low

## Symptom

For a schedule armed on another machine (`scheduleOnOtherHost: true`) that has been off
for two days, the row's accessible name says "Next run: 11/13/2026, 9:00:00 AM", but its
clock button's title says "Next run: 11/10/2026, 9:58:34 PM", a time in the past. The
context-menu **Edit schedule…** item's title shows the same stale time. The same happens
briefly on this machine after startup, before the scheduler re-arms. Conversely, a
schedule with no host value (paused, or just after a save) gets the generic
"Schedule workflow…" title.

## Steps to Reproduce

1. A lineage with a daily schedule whose `scheduleNextRunAt` (from the host, passed
   through `RecentWorkflowCatalog.ts`) is two days old.
2. Hover the row's clock button: the tooltip shows the old time; the row text shows the
   next real occurrence.

## Root Cause

`ScheduleRowActionButton`
(#selection:src/ui/webview-react/components/workflow/WorkflowRowLayout.tsx:208-216) and
the context-menu item (#selection:src/ui/webview-react/hooks/useWorkflowContextMenu.tsx:276-283)
print `scheduleNextRunAt` directly. The row text uses `upcomingScheduleRunAt`
(`src/ui/webview-react/utils/workflowScheduleDisplay.ts`), which only trusts the host
value while it is in the future and otherwise computes the next occurrence.

## Suggested Fix

Have both titles use `upcomingScheduleRunAt` (and the paused label `RecentWorkflowRow`
uses), so tooltip, menu item and row text come from one helper. Add Vitest coverage with a
stale `scheduleNextRunAt`.
