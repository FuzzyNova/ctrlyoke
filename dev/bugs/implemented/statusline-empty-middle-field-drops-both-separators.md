# Statusline: an empty field between two non-empty fields removes both separators

- **Found:** 2026-10-02 by bug-hunt final step (claude-cli), reproduced with a tsx probe
- **Area:** `src/utils/StatuslineFormat.ts` (`formatBrandedStatusLine`, the literal filter ~732-755)
- **Resolution:** fixed in this commit

## Symptom

With a format like `[model, "·", usage1, "·", usage2]` and no five-hour window
(a common state: each rate-limit window can be absent independently), the
statusline renders `opus week 41%` instead of `opus · week 41%`. The same thing
happens with `[model, "·", branch, "·", version]` outside a git repo:
`opus 2.1` instead of `opus · 2.1`. This affects the terminal statuslines
(Claude, Antigravity, Copilot, Qwen) and the settings live preview
(`StatusLinePreview.tsx`).

## Steps to Reproduce

1. Call `formatBrandedStatusLine` for provider `claude` with format
   `[model, "·", usage1, "·", usage2]` and payload
   `{model:{id:"opus"}, rate_limits:{seven_day:{used_percentage:41.2}}}`.
2. Output: `opus week 41%`.

## Root Cause

The filter drops a literal whenever its nearest field before *or* its nearest
field after rendered empty. When an empty field sits between two non-empty
fields, the literals on both sides of it meet that rule, so both are dropped.
The design (`dev/implemented/STATUSLINE_FORMAT_CUSTOMIZATION_PLAN.md`) calls for
absence-aware separators that remove only the separator left dangling.
`StatuslineWrapper.test.ts` only covers one literal between two fields.

## Suggested Fix

Treat the literal runs between consecutive *non-empty* fields as candidates and
keep exactly one run per gap: for example, keep the run directly before the next
non-empty field, and drop leading/trailing runs that have no non-empty field on
one side. Add tests for field·empty·field, empty·field, field·empty, and
field·empty·empty·field.
