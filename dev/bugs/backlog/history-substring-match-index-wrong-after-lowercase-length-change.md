# Plain-text history search reports a shifted match index when lowercasing changes the text length

- **Found:** 2026-09-28 by lots-of-bug-fixes final step (Claude)
- **Area:** `src/core/orchestration/HistorySearchMatcher.ts`, `src/core/orchestration/HistorySearchResultUtils.ts`
- **Severity:** low

## Symptom

For history text containing characters whose lowercase form has a different UTF-16 length (for
example Turkish `İ`, U+0130, which lowercases to two code units), a plain-text search finds the
match but reports the wrong position. The result row's snippet is empty (`…`) or centered on the
wrong text, and the highlight is misplaced.

## Steps to Reproduce

Call `SubstringHistorySearchMatcher.find` (via `createHistorySearchMatcher` with the plain query
`error`) on `"İ".repeat(60) + " ERROR here"`.

- Actual: `{ index: 121, length: 5 }`; `text.slice(121, 126)` is `""` and `extractSnippet`
  returns `"…"`.
- Expected: `{ index: 61, length: 5 }` and a snippet containing `ERROR here`.

## Root Cause

`SubstringHistorySearchMatcher.find` (around lines 258-263) runs
`text.toLowerCase().indexOf(loweredQuery)` and returns that index as if it pointed into the
original `text`. `toLowerCase` is not length-preserving, so each length-changing character before
the match shifts the index. `HistorySearchMatch.index/length` must point into the original text,
because `extractSnippet` slices the original text.

## Suggested Fix

Search case-insensitively without changing length, for example with a cached regex built from the
escaped query and the `i` flag, or map the lowered index back to the original by lowercasing per
code point. Make `length` reflect the matched original span. Add a unit test with `İ` before the
match, and check `findAsync` too.
