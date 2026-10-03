# Claude statusline preview labels usage windows by array position, so a lone 7-day window shows as "5h"

- **Found:** 2026-10-02 by bug-hunt final step (Claude)
- **Area:** `src/ui/webview-react/components/settings/stats/StatusLinePreview.tsx` (`previewPayload`, Claude branch ~lines 170-178)
- **Severity:** low

## Symptom

With a cached Claude usage snapshot that holds only the 7-day window, the
Settings > Stats & Usage "Live preview" for the format `[usage1, "·", usage2]`
renders `5h 41%`. The real Claude Code statusline, given
`rate_limits: { seven_day: { used_percentage: 41 } }`, renders `week 41%`.
This was verified with `npx tsx` using the real parser and the exact mapping
code.

## Steps to Reproduce

1. Have a Claude usage snapshot in which the five-hour window is absent or
   out of range. `parseClaudeRateLimitWindows` in
   `src/core/harness/shared/usage/providers/ClaudeUsageProvider.ts` skips such
   windows, and `dev/implemented/HARNESS_USAGE_TRACKING_PLAN.md` notes that
   each window can be absent.
2. Open the statusline format editor for Claude. The preview mislabels the
   window and moves `usage1`/`usage2` content into the wrong slot.

## Root Cause

```ts
windows.slice(0, 2).map((window, index) => [
  index === 0 ? "five_hour" : "seven_day", ...
```

The payload key is chosen by index instead of by `window.id`. The
Antigravity branch of the same function already keys by `window.id`.

## Suggested Fix

Map each window by its id: `five-hour` → `five_hour` and `seven-day` →
`seven_day`, using the existing id constants instead of literals, and drop
unknown ids. Add a `StatusLinePreview.test.tsx` case that passes a snapshot
containing only the seven-day window.
