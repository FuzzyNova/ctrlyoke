# History regex search drops `{n,}` matches, shares cached results across case-different regexes, and hangs on regex timeout

- **Found:** 2026-09-30 by the bug-backlog workflow final step (claude-cli), reproduced against the compiled modules
- **Area:** `src/core/orchestration/HistorySearchMatcher.ts` (`readQuantifier` ~618), `src/core/orchestration/HistorySearchIndexService.ts` (`getSnapshotKey` ~1183), `src/ui/WebviewMessageRouter.ts` (`getHistorySearchListingKey` ~145, `SEARCH_HISTORY` handler ~1535)
- **Resolution:** fixed in this commit

## Symptom

1. **`{n,}` is read as `{n}`.** `createHistorySearchMatcher("ab{1,}c", true).requiredLiteral`
   is `"abc"`, so the literal prefilter rejects a line containing `abbc` even though
   `/ab{1,}c/i` matches it (`err{1,}or` vs `errrror` likewise). The CLI
   (`ctrlyoke history search --regex 'err{1,}or'`) always hits this because it scans
   with the document cache off; the extension hits it on uncached shards. This is the
   case the earlier fix `history-regex-prefilter-joins-quantified-literals` missed.
2. **Regex queries that differ only by case share a cache entry.** Both the snapshot key
   and the dashboard listing key use `query.trim().toLowerCase()`, so `\d{3}` and
   `\D{3}` (also `\w/\W`, `\s/\S`, `\b/\B`, `\p/\P`) are the same key. Searching `\d{3}`
   then `\D{3}` returns the first search's results; the router also treats the second as
   the same listing and doesn't cancel the first.
3. **A regex timeout never reaches the dashboard.** `HistorySearchService.search` rethrows
   `HistorySearchRegexTimeoutError`, but the `SEARCH_HISTORY` handler only converts
   `InvalidHistorySearchPatternError` to `SEARCH_HISTORY_ERROR`; anything else is only
   logged, so for a catastrophic pattern like `(a+)+$` the client gets neither results nor
   an error and `historySearchLoading` never clears.

## Steps to Reproduce

1. `node -e 'console.log(/^\{(\d+)(?:,(\d*)?)?\}/.exec("{1,}"))'` → group 2 is
   `undefined`, so `maximum = minimum = 1` and `exactlyOne` is true.
2. Record a run whose output has `abc123`; search regex `\d{3}` (1 hit), then `\D{3}`
   → the same hit is returned from the snapshot.
3. Dashboard history search, regex on, `(a+)+$` over enough text to hit the timeout →
   spinner forever.

## Root Cause

1. In `/^\{(\d+)(?:,(\d*)?)?\}/`, the optional group around an empty `\d*` is
   `undefined` for `{1,}`, which the code treats as "no comma".
2. Case-folding the key is only valid for case-insensitive substring search; a regex's
   escapes are case-significant.
3. Missing error mapping for the timeout error.

## Suggested Fix

1. Use `/^\{(\d+)(,(\d*))?\}/` and treat "comma present, empty max" as unbounded.
   Tests: `ab{1,}c`, `x{1,}`, `a{2,}`, `a{1,1}`.
2. Lowercase the query only when `regex` is false, in both keys (single-source a helper
   used by both). Test that `\d{3}` and `\D{3}` produce different keys/results.
3. Map `HistorySearchRegexTimeoutError` to `SEARCH_HISTORY_ERROR` with a new error code
   constant, and make sure the client clears loading on it. Router test.
