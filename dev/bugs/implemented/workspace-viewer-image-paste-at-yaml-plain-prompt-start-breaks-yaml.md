# Pasting an image at the start of a plain YAML prompt in the workspace viewer makes the file invalid

- **Found:** 2026-11-12 by the bug-hunt workflow's final step (claude-cli), from code reading; reproduced with the repo's `yaml` parser
- **Area:** `src/ui/webview-react/utils/pastedImages.ts` (`pasteImagesAsReferences`), `src/ui/webview-react/components/workspace-viewer/WorkspaceFileEditor.tsx` (`canPasteImagesAtSelection`)
- **Resolution:** fixed in this commit

## Symptom

0.7.0 lets you paste an image into the prompts of a workflow file in the workspace
viewer; it is saved under `.ctrlyoke/attachments/` and an `@` reference is inserted.
When the caret is at the first character of a plain (unquoted) YAML prompt, e.g.
`- prompt: Fix the bug` with the caret before `F`, the result is

```yaml
- prompt: @.ctrlyoke/attachments/<name>.png Fix the bug
```

YAML reserves `@` as the first character of a plain scalar, so the workflow no longer
parses (`BAD_SCALAR_START: Plain value cannot start with reserved character @`). While
the save is in flight the `[Pasting image…]` placeholder at that position already
breaks the file: a leading `[` starts a flow sequence. The same paste in the middle or
at the end of the prompt is fine.

## Steps to Reproduce

1. Open a `.ctrlyoke.yaml` workflow in the workspace viewer with
   `- prompt: Fix the bug`.
2. Put the caret right after `prompt: ` and press Ctrl/Cmd+V with an image on the
   clipboard (or right-click → **Paste**).
3. The line becomes `- prompt: @.ctrlyoke/attachments/… Fix the bug`; the file shows a
   YAML parse error and the workflow fails to load. Confirmed with
   `YAML.parseDocument("steps:\n  - prompt: @.ctrlyoke/attachments/a.png Fix it\n")`.

## Root Cause

`canPasteImagesAtSelection`
(#selection:src/ui/webview-react/components/workspace-viewer/WorkspaceFileEditor.tsx:850-862)
accepts any caret inside an exact prompt span, including the first offset of a plain
scalar. `pasteImagesAsReferences`
(#selection:src/ui/webview-react/utils/pastedImages.ts:213-275) inserts the placeholder
and then the raw reference text with no knowledge of the scalar style. The completion
path does handle this: `WorkflowFileCompletionCore.ts` quotes a value that matches
`YAML_UNSAFE_PLAIN` (whose comment notes `@` is reserved as a first character), and
`WorkflowInsertEscape.ts` escapes per scalar style. The paste path uses neither.

## Suggested Fix

Let the caller tell `pasteImagesAsReferences` how to place text, e.g. an optional
`prepareInsertion(view, from)` hook passed from `WorkspaceFileEditor`. When the
selection starts at the first character of a plain YAML prompt scalar (the span's
`sourceRange.start` for a plain-style span), first rewrite the scalar as a
double-quoted scalar (its current text JSON-escaped with `escapeJsonStringFragment`),
then insert the placeholder and reference inside the quotes. Text pasted anywhere else
stays as it is today. `WorkflowTextSpan` (`src/completions/WorkflowTextDecoding.ts`)
does not record the scalar style; add an optional `scalarStyle` where YAML spans are
built rather than re-deriving it from the source text. Add Vitest coverage: a paste at the start of a plain scalar
yields a document that parses, with the original prompt text plus the reference; a
paste in the middle of the scalar is unchanged; double-quoted and block scalars are
unchanged.
