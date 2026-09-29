# Markdown export breaks when exported content contains a code fence

- **Found:** 2026-09-28 by lots-of-bug-fixes final step (Claude)
- **Area:** `src/ui/webview-react/utils/markdownExport.ts`
- **Resolution:** fixed in this commit

## Symptom

The dashboard's Markdown export wraps prompts, responses, bash output and errors in a fixed
triple-backtick fence. AI output and prompts often contain their own ` ``` ` fences, which
close the export's fence early, so the rest of the exported document renders as broken markdown.

## Steps to Reproduce

Export a run whose bash command output (or prompt/response) contains
` ```js\nconsole.log(1)\n``` `. The exported markdown's fences are unbalanced.

## Root Cause

`markdownExport.ts` pushes literal `"```"` lines (around lines 183-193 and 476-509) instead
of choosing a fence longer than any backtick run in the content. This is the same class as
`dev/bugs/implemented/commit-diff-fence-broken-by-backticks-in-diff.md`, which introduced
`fenceLiteral()` in `src/utils/FileReferenceParser.ts`.

## Suggested Fix

Reuse `fenceLiteral()` for every fenced block in the export, or move it to a shared
webview-safe utility if importing it would pull in extension-only code. Add a vitest test with
content containing ` ``` ` and ` ` ````.
