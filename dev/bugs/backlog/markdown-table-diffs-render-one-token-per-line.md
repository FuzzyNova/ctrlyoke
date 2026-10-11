# Markdown table rows in diffs render one token per line

- **Found:** 2026-10-11 by Claude (File changes and workspace viewer docs captures)
- **Area:** `src/ui/webview-react/components/diff/`, `src/ui/webview-react/components/output/DiffView.tsx`
- **Severity:** medium

## Symptom

In a diff of a markdown file, each table row is broken apart: every `|`, cell
text and `------` separator renders on its own visual line, so a 15-line README
change fills several screens and is unreadable. Ordinary markdown lines (headings,
prose) render normally.

Seen in both the **Workflow changes** dialog and the workspace viewer's commit
diff, so it's in the shared diff renderer, not one surface.

## Steps to Reproduce

1. In the demo project, open the hosted dashboard, then **Explore files and
   changes** → **Source Control**.
2. In History, select `feat(notes): add search, pagination, tags, and PATCH endpoint`.
3. Expand `README.md`: the endpoint table (`| Method | Path | Description |`) shows
   `|`, `Method`, `|`, `Path`, … each on its own line.

The same happens with **View 8 changes** on the `hero-gif` run 4 and expanding
`README.md`.

## Root Cause

Not investigated. It looks like the markdown syntax highlighter emits table
cells as block-level elements (or elements with `display: block`) inside the
diff line, which forces a line break per token. Code files highlight normally.

## Suggested Fix

Find the token classes the markdown grammar produces for table cells and
delimiters, and make sure the diff line renders them inline (or highlight
markdown diff lines with an inline-only grammar). Add a diff rendering test
with a markdown table row that asserts one rendered line per diff line.
