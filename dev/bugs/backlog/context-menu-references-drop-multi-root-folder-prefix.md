# Context-menu and SCM "Add to Prompt" references drop the folder name in multi-root workspaces

- **Found:** 2026-10-02 by bug-hunt final step (Claude)
- **Area:** `src/completions/WorkspaceReferencePaths.ts`
- **Severity:** medium

## Symptom

In a multi-root workspace (folders `frontend`, primary, and `backend`),
right-clicking `backend/src/app.ts` and choosing Add File / Add Selection /
Add Symbol / Add Directory, or adding an SCM resource to the prompt, inserts
`@src/app.ts`. At run time that resolves against the primary root: it
silently attaches `frontend/src/app.ts` if that exists, or reports the
reference as skipped. Picking the same file from `@` completion correctly
inserts `@backend/src/app.ts`.

## Steps to Reproduce

1. Open a two-folder multi-root workspace.
2. Right-click a file in the second folder → ctrlyoke Add to Prompt.
3. The inserted reference has no folder prefix.

## Root Cause

`toWorkspaceRelativeReferencePath` calls
`vscode.workspace.asRelativePath(uri, false)`, always omitting the folder
name. Every other reference path builder (`CompletionHelpers.ts` ~472, ~685,
~1110) passes `isMultiRootWorkspace()`. Callers:
`ContextMenuReferenceCommands.resolveReferencePath` and
`addScmResourcesToPromptEditor`.

## Suggested Fix

Pass `isMultiRootWorkspace()` so the context-menu path matches the completion
path. Add a unit test with a mocked two-folder workspace.
