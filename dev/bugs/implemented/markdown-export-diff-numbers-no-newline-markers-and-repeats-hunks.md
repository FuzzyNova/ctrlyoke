# Markdown export numbers "No newline" markers as context lines and repeats duplicate hunks

- **Found:** 2026-10-02 by bug-hunt final step (claude-cli), reproduced in a scratch Vitest test
- **Area:** `src/ui/webview-react/utils/markdownExport.ts` (`formatStructuredPatchForMarkdown` ~108-133)
- **Resolution:** fixed in this commit

## Symptom

In an exported run, a diff touching a file without a trailing newline shows
fake numbered context lines (`  11 |  No newline at end of file`), and every
line after the marker is numbered one too high. Hunks that the dashboard
de-duplicates are exported once per copy.

## Steps to Reproduce

Export a `FILE_EDIT` whose `structuredPatch` contains this hunk twice (oldStart/newStart 10):
`["-old last", "\\ No newline at end of file", "+new last", "+another", "\\ No newline at end of file"]`.

Actual output:

```
-  10 | old last
   11 |  No newline at end of file
+  11 | new last
+  12 | another
   12 |  No newline at end of file
```

The block then appears a second time. Expected: `+  10 | new last`,
`+  11 | another`, the markers either left out or not numbered, and one copy of
the hunk.

## Root Cause

Every line that doesn't start with `+` or `-` falls into the context branch,
including `\` marker lines, so both counters advance. The function also never
calls `normalizeStructuredPatch` (`diffUtils.ts`), which the UI uses to drop
duplicate hunks.

## Suggested Fix

Normalize the patch first, and handle `\` marker lines explicitly: skip them, or
emit them without a number. Ideally use the same rendered-diff-line helper as the
find fix in `output-find-diff-search-counts-unrendered-prefixes-and-markers.md`.
