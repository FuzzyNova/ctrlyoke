# Copy Metadata shows `priorContext: (none)` for the `{ previous: N }` form

- **Found:** 2026-10-01 by bug-hunt final step (claude-cli)
- **Area:** `src/ui/webview-react/utils/stepMetadataClipboard.ts`
- **Severity:** low

## Symptom

A step with `priorContext: { previous: 3 }` (added in 8f317f5cd), or one that
inherits that value from settings, copies as `priorContext: (none)` (or
`(none) (inherited)`) from the dashboard's "Copy Metadata" action, although the
run injects the last 3 step outputs. A run-address `priorContext` object also
copies as `(none)`.

## Steps to Reproduce

1. Set a step's prior context to "Last N steps" with N = 3.
2. Use "Copy Metadata" on that step and paste.
3. The clipboard says `priorContext: (none)`.

## Root Cause

`fmtPriorContext` (`stepMetadataClipboard.ts` ~111) handles only arrays and
strings and returns `"(none)"` for every object form. 8f317f5cd updated the other
two prior-context formatters (`priorContextBadge` in
`components/shared/tabBadgeUtils.ts` and the properties drawer, via
`formatPriorContextLabel` in `components/shared/PriorContextSelect.tsx`) but not
this one.

## Suggested Fix

Delete the local formatter and reuse `formatPriorContextLabel` (or whichever
shared formatter covers every `PriorContext` variant, including run addresses),
so all three surfaces stay in sync.
