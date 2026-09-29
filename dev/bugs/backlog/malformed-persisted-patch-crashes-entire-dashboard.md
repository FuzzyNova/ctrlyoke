# A malformed persisted patch crashes the entire dashboard

- **Found:** 2026-09-29 by user, after restoring run history from the search index
- **Area:** `src/ui/webview-react/components/output/` (file-edit diff rendering)
- **Severity:** high

## Symptom

The dashboard failed to launch and showed only the top-level error screen:

```
ctrlyoke encountered an error.
Hunk at line 3 contained invalid line [… truncated: recovered from the history search index]
```

The message comes from jsdiff's `parsePatch`. One `fileEdit` event in one
historical run had a hunk line with no `+`/`-`/space/`\` prefix. Rendering that
single output row threw, and nothing between the row and the root caught it,
so the whole webview went down. It could not recover without editing
`events.jsonl` by hand.

## Steps to Reproduce

1. In any run's `events.jsonl`, add a line like `"not a patch line"` to a
   `fileEdit` event's `data.structuredPatch[0].lines`.
2. Open the dashboard on that run, or on any view that renders it.
3. The top-level "ctrlyoke encountered an error" screen replaces the whole
   dashboard.

## Root Cause

Persisted `structuredPatch` data is treated as trusted and parsed during
render. `parsePatch` throws on invalid hunk lines, and there is no per-row (or
per-output-section) error boundary. History files can be corrupted by hand
edits, recovery tools, older writers or truncation, so one bad event breaks
every view.

## Suggested Fix

- Validate or normalize `structuredPatch` before parsing: drop or escape lines
  without a valid prefix and recompute hunk counts. Fall back to showing the
  raw text if it still fails to parse.
- Wrap each output row, or at least each file-operation card, in an error
  boundary that renders a compact "could not render this event" row.
