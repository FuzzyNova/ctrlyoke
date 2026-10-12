# Trusting an external root still reformats the whole YAML workflow file

- **Found:** 2026-10-12 by Claude (bug-drain review of ~0d920a9a1)
- **Area:** `src/utils/WorkflowSourceEditor.ts`
- **Severity:** medium

## Symptom

~0d920a9a1 fixed loss of comments, block scalars, anchors and quote styles when "Trust for this
workflow" writes `trustedExternalRoots`, but the YAML file is still reformatted:

- CRLF files are rewritten entirely as LF, a whole-file diff on Windows.
- 4-space indentation becomes 2-space; an unindented `steps:\n- prompt: x` sequence becomes indented.
- Runs of blank lines collapse to one.
- A UTF-8 BOM is dropped.
- An existing `trustedExternalRoots: [C:/a] # keep` becomes block style and loses its comment.
- A flow-style root `{steps: [...]}` is re-spaced.

`dev/bugs/implemented/workflow-trust-rewrite-strips-yaml-formatting.md` lists "re-indents the
whole file" as a symptom, so that fix is partial. A UTF-8 BOM also makes JSON workflows throw in
`parseWorkflowSourceJson` (not a regression; the trust choice is simply not offered).

## Root Cause

`WorkflowSourceEditor.ts` edits the YAML via `parseDocument` and then serializes with
`String(document)`, which rebuilds the whole file from the tree. The new tests only cover LF files
with 2-space indentation and the key absent.

Separately, `detectFormattingOptions` in `WorkflowSourceEditor.ts` is a verbatim copy of the one in
`src/utils/HarnessMcpExporter.ts`, and `src/utils/HarnessLspExporter.ts` has a third variant.

## Suggested Fix

Edit the YAML text, not the serialized tree. Parse with `parseDocument` only to locate things:
if `trustedExternalRoots` exists, replace just the source slice covered by its value node's
`range` (preserving a trailing comment and the existing flow/block style where practical);
if absent, append `trustedExternalRoots:` and its items at the end of the root mapping using the
file's own line ending and indentation. Preserve a leading BOM in both YAML and JSON (strip before
parse, re-add on write). Export one `detectFormattingOptions` and use it in all three modules. Add
tests for CRLF, 4-space and unindented sequences, BOM, key present (block and flow with comment),
and JSON with BOM.
