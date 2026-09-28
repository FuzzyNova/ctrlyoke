# History Search filter badge counts one date-range filter as up to three

- **Found:** 2026-09-27 by the long-running bug-fix workflow final step (claude-cli, helper agent)
- **Area:** `src/ui/webview-react/store/uiStore.ts` (`getHistorySearchActiveFilterCount`)
- **Resolution:** fixed in this commit

## Symptom

Choosing "Last 7 days" in the History Search drawer shows a filter badge of **3** and the
aria-label "History search filters (3 active)". A scratch vitest confirmed:

- `dateRange = { preset: "last7", ...getDatePresetRange("last7") }` → count `3`, expected `1`.
- A custom range with only `from` set → count `2`, expected `1`.

The drawer has six filter groups, yet `HistorySearchDrawer.test.tsx` (~line 710) expects
"(8 active)", encoding the bug.

## Steps to Reproduce

1. Open History Search in the dashboard.
2. Pick the "Last 7 days" date preset.
3. The filter button badge reads 3.

## Root Cause

`getHistorySearchActiveFilterCount` (`uiStore.ts:~365-377`) scores the date range three times:
`preset !== default`, `from.length > 0`, and `to.length > 0`. `WorkflowStatus.tsx` (~720) already
treats the date range as a single boolean.

## Suggested Fix

Count the date range once: `preset !== DEFAULT_DATE_RANGE_FILTER.preset || from.length > 0 || to.length > 0`.
Update the drawer test to expect "(6 active)" and add a store test for a preset range counting as 1.
