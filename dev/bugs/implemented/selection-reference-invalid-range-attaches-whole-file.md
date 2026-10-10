# `#selection`/`#sym` with line 0 attaches the whole file, and a reversed or past-the-end range attaches an empty excerpt

- **Found:** 2026-10-10 by claude-cli bug-hunt final step (confirmed with a scratch `npx tsx` script against `ContextExpander`)
- **Area:** `src/utils/ContextExpander.ts`
- **Resolution:** fixed in this commit

## Symptom

The editor lint (`src/ui/PromptEditorSupportService.ts`, ~1083-1105) flags an
invalid line range as "selection not found". At run time, though:

- A range starting at line `0` (`#selection:a.ts:0-2`, `#sym:a.ts:foo:0-1`)
  is attached as the **whole file**, and `sanitizeReferences` rewrites it to
  `@a.ts`. A user who asked for 2 lines sends the entire file to the model.
- A reversed range (`#selection:a.ts:4-2`) or one past the end of the file
  (`#selection:a.ts:40-50`) is attached as an empty excerpt ("Excerpt from
  a.ts, lines 4 to 2" with an empty code block).

In none of these cases is the reference added to `skippedReferences`, so no
"could not be attached" diagnostic is shown.

## Steps to Reproduce

Workspace contains `a.ts` with 5 lines. Use
`new ContextExpander({ workspaceRoot })` and call `expandContextSplit(prompt)` /
`sanitizeReferences(prompt)`:

```
#selection:a.ts:0-2   -> directFileRefs ['a.ts'] (whole file), skipped [], sanitized "@a.ts"
#sym:a.ts:foo:0-1     -> directFileRefs ['a.ts'] (whole file), skipped []
#selection:a.ts:4-2   -> empty excerpt, skipped []
#selection:a.ts:40-50 -> empty excerpt, skipped []
```

## Root Cause

`ContextExpander` decides whether a reference has a line range by testing
`ref.startLine && ref.endLine` for truthiness. `0` is falsy, so it falls through
to the whole-file path. This happens at `src/utils/ContextExpander.ts:410`
(`expandContextSplit`), `:634` (`sanitizeReferences`), `:844`, `:886` and `:892`
(attachment ids). `buildAttachmentXml` (~`:998-999`) then slices
`lines.slice(startLine - 1, endLine)` without checking the range at all.

## Suggested Fix

- Use a single `hasLineRange(ref)` helper (`startLine !== undefined &&
endLine !== undefined`) in every one of those places.
- Validate the range once (`startLine >= 1`, `endLine >= startLine`,
  `endLine <= lineCount`). An invalid range goes to `skippedReferences` with a
  reason, the same way a missing file does. Use the same rule as the editor
  lint, and share the validator with it if that is practical.
- `sanitizeReferences` must never turn a `#selection:`/`#sym:` into `@file`.

Tests in `src/test/contextExpander.test.ts`: line 0, reversed, and
past-the-end ranges for both `#selection` and `#sym` are skipped, not attached.
