# `ctrlyoke history search --until <date>` excludes the whole named day

- **Found:** 2026-10-02 by bug-hunt final step (Claude)
- **Area:** `src/cli/HistoryTime.ts`, `src/cli/HistoryInspectionCommands.ts`
- **Severity:** low

## Symptom

`ctrlyoke history search hello --until 2026-10-02` excludes runs started on
2026-10-02, and `--since D --until D` matches almost nothing. The dashboard's
"to" date filter includes the whole day (`getDateEndMs` in
`src/ui/webview-react/utils/dateRangeFilter.ts`, `T23:59:59.999`), so the two
surfaces give different results for the same date.

## Steps to Reproduce

1. Have a run that started at `2026-10-02T16:53Z` and matches `hello`.
2. `ctrlyoke history search hello --until 2026-10-02 --json` returns `totalCount: 0`.
3. `--until 2026-10-02T23:59` returns the matches.

## Root Cause

`parseHistoryTime` turns a date-only value into midnight at the start of that
day, and the filter excludes `startedAt > until` (`HistorySearchFilters.ts`).
It is used for both `--since` and `--until` with no notion of which bound it is
parsing. This is distinct from `history-time-accepts-invalid-dates-and-mixes-timezones`
(implemented), which covered invalid dates and timezone mixing.

## Suggested Fix

Give `parseHistoryTime` a `bound: "start" | "end"` parameter. For `end`, a
date-only value resolves to the last millisecond of that day, in the same
timezone convention `parseHistoryTime` already uses for date-only input. Pass
`end` for `--until` in every caller. Update the `--until` help text and
`docs/cli/ctrlyoke.md` to say that a date-only `--until` includes that day.
Add unit tests.
