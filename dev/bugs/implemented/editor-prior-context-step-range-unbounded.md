# The editor's `$step:` range parser has no size limit (webview copy of the fixed backend bug)

- **Found:** 2026-09-28 by lots-of-bug-fixes final step (Claude)
- **Area:** `src/ui/webview-react/utils/atomicReferences.ts`
- **Resolution:** fixed in this commit

## Symptom

`dev/bugs/implemented/prior-context-step-range-unbounded-expansion.md` bounded
`RangeNotationParser.parseRangeNotation`, but the webview has its own private parser,
`parsePriorContextStepRange`, which still expands every range into a full array:

- `findInlinePriorContextRefs("see $step:1-20000000")` builds a 20-million-element array on the
  UI thread.
- `$step:1-5000000000` throws `RangeError`.

This runs on every keystroke in the editor (reference chips) and in `OutputRow`, so typing a large
range freezes or crashes the dashboard. The copy also accepts `$step:0`, which the backend
rejects, so the editor shows a chip that the run will skip.

## Steps to Reproduce

In a vitest test, call `findInlinePriorContextRefs("see $step:1-5000000000")`. It throws
`RangeError` after a long stall.

## Root Cause

`parsePriorContextStepRange` (around line 855) duplicates the range grammar instead of reusing
`src/utils/RangeNotationParser.ts`, and has no cap or safe-integer check.

## Suggested Fix

Delete the private copy and call `parseRangeNotation` (it is free of `vscode` and Node imports, as
the webview requires), so the cap and validation are single-sourced. Add a vitest test for a huge
range and for `$step:0`.
