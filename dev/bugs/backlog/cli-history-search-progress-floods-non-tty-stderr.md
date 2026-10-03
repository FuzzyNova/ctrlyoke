# `history search` writes one progress line per rebuild tick, flooding non-TTY stderr

- **Found:** 2026-10-02 by Claude (claude-cli), running `ctrlyoke history search` with output piped
- **Area:** `src/cli/HistoryInspectionCommands.ts` (`searchHistoryCommand`)
- **Severity:** low

## Symptom

During an index rebuild, `history search` prints a new line to stderr for every
progress callback:

```
Rebuilding search index (0/1648 runs)…
Rebuilding search index (1/1648 runs)…
Rebuilding search index (4/1648 runs)…
… (235 lines in one run, 174 in another)
```

In a terminal this scrolls the screen. When output is piped or captured, which is how
agents run it (`2>&1 | head`), the progress lines take up the whole budget.
`2>&1 | head -40` showed nothing but progress and cut off the results.

## Steps to Reproduce

1. Make the search index stale (see `history-search-index-hash-ignores-drive-letter-casing.md`).
2. `ctrlyoke history search worktree --limit 5 2>&1 | head -40`
3. All 40 lines are `Rebuilding search index (…)`.

## Root Cause

The progress callback in `searchHistoryCommand`
(`HistoryInspectionCommands.ts` ~293-298) calls `io.writeErr` once per tick with no
TTY check and no throttling.

## Suggested Fix

- TTY stderr: rewrite a single line in place (`\r`), throttled to about 4 Hz.
- Non-TTY stderr: print at most one `Rebuilding search index (N runs)…` line, plus
  optionally a completion line with the elapsed time.
- Never write progress to stdout. With `--json`, stdout already carries only the
  result blob; keep it that way.
