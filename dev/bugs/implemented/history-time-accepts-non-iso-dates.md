# `history --since/--until` silently accepts non-ISO input such as `7`

- **Found:** 2026-09-27 by the long-running bug-fix workflow final step (claude-cli)
- **Area:** `src/cli/HistoryTime.ts` (`parseHistoryTime`)
- **Resolution:** fixed in this commit

## Symptom

`docs/cli/ctrlyoke.md:436` documents `--since` / `--until` as "an ISO-8601 time or a
relative `7d`, `24h`, `30m`", and the error message promises the same. But a
mistyped value that V8's lenient `Date.parse` can guess at is accepted without a
word. `ctrlyoke history search foo --since 7` (unit forgotten) filters from
**2001-07-01** instead of failing, so the user gets results from the wrong window.

Reproduced by running the source with `tsx`:

```
parseHistoryTime("7")        // 2001-07-01T05:00:00.000Z (local-time dependent)
parseHistoryTime("Monday 7") // same
parseHistoryTime("1w")       // throws (correct)
```

## Steps to Reproduce

1. `ctrlyoke history search anything --since 7`
2. No error. Runs back to 2001 are included.

## Root Cause

When the relative regex misses, `parseHistoryTime` (`HistoryTime.ts:26`) falls back
to `Date.parse(normalized)` and accepts any finite result. `Date.parse` accepts many
non-ISO, implementation-specific strings. There are no unit tests for
`parseHistoryTime`.

## Suggested Fix

Before calling `Date.parse`, check the input against an ISO-8601 shape:
`YYYY-MM-DD`, optionally followed by `THH:MM[:SS[.sss]]` and an optional `Z` or
`±HH:MM`. Reject anything else with the existing error. Add unit tests covering valid
relative values, valid ISO date and date-time forms, and rejected inputs (`7`,
`Monday 7`, `1w`, `2 days`).
