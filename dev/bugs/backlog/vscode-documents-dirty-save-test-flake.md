# `VsCodeDocuments > saves an open dirty document` still flakes under sharded runs

- **Found:** 2026-10-08 by Claude (claude-cli), in the full `npm test` run after merging Wave 2 of the editor intelligence plans
- **Area:** `src/test/suite/VsCodeDocuments.test.ts`, `src/platform/VsCodeDocuments.ts` (`saveIfDirty`)
- **Severity:** low (test-only so far)

## Symptom

One `npm test` run on `main` failed this test, in extension shard 6/6; the other 5,837
extension tests passed. The diagnostics added in `7ca187777` printed:

```
saveIfDirty did not persist the open document: {"filePath":"…\\ctrlyoke-document-YvDBL2\\workflow.md",
"elapsedMs":8,"documentIsDirty":true,"matchingOpenDocumentCount":0,"savedContents":"before"}
```

The document is still dirty, yet it is missing from `vscode.workspace.textDocuments`. So
`saveIfDirty` finds nothing and returns without saving. No save event fired
(`saveEventElapsedMs` is absent).

## Steps to Reproduce

Intermittent. Run `npm test` (sharded) repeatedly. Full output of the failing run:
`.ctrlyoke/logs/test-runs/npm-test-2026-10-08T18-22-19-724Z.log`. Nothing in the Wave 2 merge
touches either file.

## Root Cause

Not confirmed. The test already pins the document with
`showTextDocument(document, { preview: false })`, to keep it out of the hidden-model pool that
the comment blames. A count of 0 while `document.isDirty` is true means the pinned editor's
model was still dropped from `textDocuments`. One possibility is an earlier suite in the same
shard closing every editor, as several teardowns do with `workbench.action.closeAllEditors`,
with the close landing late.

If that can also happen to a real user's dirty, visible document, `saveIfDirty` silently skips
the save before a run. That matters more than the test.

## Suggested Fix

1. Log `vscode.window.visibleTextEditors` and the active editor in the failure message, to
   tell "editor closed" apart from "model evicted while visible".
2. Make `saveIfDirty` also look through `vscode.window.visibleTextEditors` and
   `tabGroups`-backed documents before concluding the file isn't open.
3. Have the test wait until the document is the active editor's document before editing.
