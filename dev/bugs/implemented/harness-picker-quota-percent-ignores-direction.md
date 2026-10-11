# Harness picker quota percentage ignores the Used/Remaining setting

- **Found:** 2026-10-11 by Claude while writing `docs/guide/usage-and-stats.md`
- **Area:** `src/ui/webview-react/utils/harnessUsageDisplay.ts`
- **Resolution:** fixed in this commit

## Symptom

**Settings → Stats & Usage → Quota percent direction** (`usageTracking.percentDirection`)
switches the usage cards and the status line between "used" and "remaining". The quota badge in
the harness dropdown and the footer harness quick picker (e.g. `Claude Code 6%`) and its tooltip
("6% 5h | 1% week") always show the amount used. With **Remaining** selected, the tab shows
"94% remaining" while the picker beside it shows `6%`, with nothing to say which one it means.

A related inconsistency: the badge shows the first window that has a percentage, not the
fullest one. For Claude that is the 5-hour window even when the weekly window is closer to its
limit, while the status line's **Peak usage %** field and the near-limit warning use the highest
window.

## Steps to Reproduce

1. Run any step on a harness that reports quota (Claude Code or Codex) so the picker shows a
   percentage.
2. In **Settings → Stats & Usage**, set **Quota percent direction** to **Remaining**.
3. The tab's cards switch to remaining capacity. The footer harness picker and the
   Workflow Properties harness dropdown still show the used percentage.

## Root Cause

`getHarnessUsageDisplay` (`harnessUsageDisplay.ts:58-121`) builds `percentOnly` from
`primaryPercentWindow.percentUsed` (line 113) and every tooltip label from `window.percentUsed`
(line 92). It takes no direction parameter. Its three callers (`HarnessQuickPicker.tsx:96`,
`HarnessDropdown.tsx:121` and `:294`) don't read `usageTracking.percentDirection` either.
Only `StatsUsageSection` and the status line components read it. `primaryPercentWindow`
(line 80) is the first window with a percentage, not the maximum.

## Suggested Fix

Pass the direction into `getHarnessUsageDisplay` (read once from the settings store in the
picker and dropdown) and format through the same used/remaining helper the status line preview
uses. Label the badge in the tooltip ("left" vs "used"). Decide whether the badge should show
the peak window to match the near-limit warning, and pin both choices with
`harnessUsageDisplay` tests.
