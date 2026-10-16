# An `@` reference written as a Markdown link renders as a chip but fails at runtime

- **Found:** 2026-10-15 by Claude Code (bug-hunt final step; reproduced against compiled `out/`)
- **Area:** `src/utils/FileReferenceParser.ts` (`parseAtReferences`), `src/utils/ReferencePatterns.ts`
- **Resolution:** fixed in this commit

## Symptom

`See [@src/a.ts](src/a.ts)` shows a valid `@src/a.ts` chip in the editor and the output pane. At
runtime the parser reads the path as `src/a.ts](src/a.ts`, and the reference is skipped with
`ENOENT … src\a.ts](src\a.ts`. Under `execution.contextResolutionFailure: fail` the step stops.
This shape is common in AI-written prompts and replies, which the `ctrlyoke-syntax` skill teaches
to cite files as `@path`.

## Steps to Reproduce

1. With `src/a.ts` present, run a step whose prompt contains `See [@src/a.ts](src/a.ts)`.
2. The editor decorates `@src/a.ts`, but the expanded prompt reports the reference as skipped.

## Root Cause

The editor/link pattern ends an unquoted path at `](`: `UNQUOTED_REFERENCE_END` in
`ReferencePatterns.ts:12` includes `\]\(`. The runtime parser
(`FileReferenceParser.ts:734-747`) matches `(?:[A-Za-z]:)?[^\s:"]+` and then strips only trailing
punctuation (`/[^\p{L}\p{N}/\\]+$/u`), so `](src/a.ts` stays in the path. The comment on
`createReferencePatterns` requires that every decorated reference also expands at runtime. A test
already asserts the editor side of this (`CodeMirrorEditorMarkdown.test.tsx:315`).

## Suggested Fix

Single-source the end rule. Export the end lookahead (or a helper that cuts an unquoted body at
the first `](`) from `ReferencePatterns.ts`, and use it in `parseAtReferences` before the
trailing-punctuation strip. Add a `FileReferenceParser` test for `[@src/a.ts](src/a.ts)` and for
`[x @src/b.ts](https://example.com)`.
