# Find-in-output counts diff matches the rendered diff never shows

- **Found:** 2026-10-02 by bug-hunt final step (claude-cli), reproduced in a scratch Vitest test
- **Area:** `src/ui/webview-react/utils/outputFind.ts` (`getStructuredPatchText` ~103-118)
- **Severity:** low

## Symptom

Searching a run's output for an ordinary word like `file` or `end` counts extra
matches on any edit to a file without a trailing newline, and searching `+` or a
leading space counts matches in the diff gutter. Stepping onto one of these
matches highlights nothing (`locateActiveDiffMatch` returns `null` or an empty
range), and can expand a collapsed diff for no visible reason. The "N of M"
counter is inflated.

## Steps to Reproduce

1. A `FILE_EDIT` event has structured patch lines
   `[" const a = 1;", "-export default a", "\\ No newline at end of file", "+export default a;", "\\ No newline at end of file"]`.
2. Search `file`: 2 matches, neither of which can be located. Search `+`: 1
   match mapped to `{start:0,end:0}`.

## Root Cause

The search text is the raw hunk lines joined with `\n`. That includes each
line's `+`/`-`/space prefix and the `\ No newline at end of file` marker lines.
The rendered diff shows neither: `markFindTokens` searches line content only,
and `locateActiveDiffMatch` skips marker lines.

## Suggested Fix

Build the search corpus from exactly what the diff renders: line content with
the prefix stripped, and no marker lines. Keep `locateActiveDiffMatch`'s offset
walk in lockstep by sharing one helper that turns a normalized patch into
rendered diff lines. Then the corpus and the locator can't drift again.
