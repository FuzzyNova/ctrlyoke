# Workflow file picker preselects a file that the git-ignored or search filter hides, and Load/Queue submits it

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/ui/webview-react/components/workflow/WorkflowFilePickerModal.tsx`
- **Severity:** low

## Symptom

In the hosted dashboard's "Load from File" and "Queue from File" pickers, the action button is enabled even when no row is highlighted. Clicking it loads or queues a workflow file the user never saw. That file is either hidden by the git-ignored filter or excluded by the current search query.

## Steps to Reproduce

1. In a git repo, set `ui.hideGitIgnoredFiles = true`. Create an untracked or gitignored workflow file whose relative path sorts first, e.g. `.scratch/a.ctrlyoke.yaml`. Also keep a tracked workflow such as `workflows/b.ctrlyoke.yaml`.
2. Open the hosted dashboard and choose Load from File (or the queue variant).
3. The list shows only `workflows/b.ctrlyoke.yaml` and no row is highlighted, yet the "Load File" button is enabled.
4. Click "Load File" without picking a row. `.scratch/a.ctrlyoke.yaml` is loaded (or appended to the queue).
5. Search variant: with any set of files, type a query that excludes the alphabetically first file, then click the action button. The excluded first file is submitted.

## Root Cause

`WorkflowFilePickerModal.tsx:72` seeds `selectedPath` from the unfiltered list with `nextFiles[0]?.path`. `filteredFiles` (lines 94-105) applies the `hideGitIgnoredFiles` and query filters but never reconciles `selectedPath` with what they leave visible. `chosenPath` (line 107) and `handleSubmit` (lines 109-115) therefore submit a path that is not on screen, and the button's `disabled={!chosenPath}` check (line 122) does not catch it.

Two other pieces of code make this likely to happen in practice:

- `src/server/CtrlYokeHostedServer.ts:1407` marks every file that git does not track as `gitIgnored`, so untracked files count as ignored too.
- `src/utils/WorkflowFileDiscovery.ts:65` sorts the files alphabetically by relative path, which puts dot-directories such as `.scratch/` first.

## Suggested Fix

Derive the effective selection from the visible list:

```ts
const effectiveSelected = filteredFiles.some((f) => f.path === selectedPath)
  ? selectedPath
  : (filteredFiles[0]?.path ?? "");
```

Use `effectiveSelected` for both `chosenPath` and the row highlight. Alternatively, resolve the selection to empty when it is filtered out, so the button disables. In either case, stop seeding `selectedPath` from the unfiltered `nextFiles[0]`.

Add two Vitest cases to `src/ui/webview-react/test/components/workflow/WorkflowFilePickerModal.test.tsx`:

- The first file has `gitIgnored: true` and `hideGitIgnoredFiles` is on. Assert that the submitted path is a visible file.
- A search query excludes the first file. Assert the same.
