# CLI history options reject a negative number as "expected an integer"

- **Found:** 2026-11-01 by bug-hunt final step (claude-cli)
- **Area:** `src/cli/HistoryFilterParsing.ts`
- **Severity:** low

## Symptom

`ctrlyoke history search hello --offset -1` fails with
`Invalid --offset value "-1"; expected an integer.` (exit 2). `-1` is an
integer; the real problem (below the minimum) is never named. `--limit -5`,
`--tail -5` and `--max-events -1` behave the same, while `--limit 0` correctly
says `expected an integer of at least 1.`

## Steps to Reproduce

1. `ctrlyoke history search hello --offset -1`
2. Observe "expected an integer."

## Root Cause

`parseHistoryInteger` (#selection:src/cli/HistoryFilterParsing.ts:26-45) tests
the shape with `/^\d+$/`, so a leading `-` fails the shape check and never
reaches the `parsed < minimum` branch that names the minimum.

## Suggested Fix

Accept an optional sign in the shape check (`/^-?\d+$/`) so negative values get
`expected an integer of at least ${minimum}`. The exit code stays 2. Add cases
to `src/test/unit/HistoryInspectionCommands.test.ts` (or a new
`HistoryFilterParsing` test); nothing covers `parseHistoryInteger` today.
