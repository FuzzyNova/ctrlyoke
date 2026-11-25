# Worktree directory suggestion inserts a basename that matches several worktrees

- **Found:** 2026-11-25 by bug-hunt workflow final step (Claude, code review of e2356239f)
- **Area:** `src/completions/WorktreeDirectoryCompletionHelpers.ts`, `src/core/orchestration/WorktreeManager.ts` (`listWorktreeDirectories`), `src/utils/WorktreeUtils.ts` (`resolveWorktreeDirectory`)
- **Severity:** low

## Symptom

A named worktree's `directory` suggestions list linked worktrees by their directory
basename, and picking one inserts only that basename. When two linked worktrees of the
same repository have the same basename in different parent folders (for example
`~/a/feature` and `~/b/feature`), the dropdown shows two identical `feature` rows. The
full path, shown since e2356239f, is the only thing that tells them apart. Picking
either row inserts `feature`, and the run then fails with
`Directory "feature" matches multiple registered worktrees: … Specify a path instead.`
So a suggestion ctrlyoke offers can never be used as offered.

## Steps to Reproduce

1. In a repository, `git worktree add ../a/feature -b f1` and
   `git worktree add ../b/feature -b f2`.
2. In the dashboard, set a step's worktree to named mode and open the `directory`
   field. Two `feature` rows appear.
3. Pick either one and run. Worktree resolution throws the "matches multiple
   registered worktrees" error.

## Root Cause

`getWorktreeDirectoryCompletions` (`WorktreeDirectoryCompletionHelpers.ts` ~31) always
uses `insertText: candidate.name`, where `name` is `path.basename(entry.worktreePath)`
(`WorktreeManager.ts` ~724). `resolveWorktreeDirectory` (`WorktreeUtils.ts` ~136)
resolves a bare name by matching it against every registered linked worktree's
basename (plus the branch-derived `<slug>-<hash>` name), and it rejects a name that
matches more than one.

## Suggested Fix

In `getWorktreeDirectoryCompletions`, when a candidate's bare name would not resolve
to exactly that worktree, insert its full `worktreePath`. That is the case when
another candidate has the same basename (compare case-insensitively on Windows and
macOS via `foldPathForCompare`). A path-form value resolves directly to the entry.
Keep the basename as the label. Add a unit test with two candidates that share a
basename, and one with a unique basename that still inserts the bare name.
