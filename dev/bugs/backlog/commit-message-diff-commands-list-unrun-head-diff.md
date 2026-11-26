# Commit-message diff provenance names a `git diff HEAD` that never ran in an unborn repository

- **Found:** 2026-11-25 by bug-hunt final step (claude-cli)
- **Area:** `src/git/CommitMessageGenerator.ts` (`getDiff`)
- **Severity:** low

## Symptom

`DiffResult.commands` is the provenance list of git commands whose output fed
the commit-message prompt. In a repository with no commits yet, calling
`getDiff` with `includeUnstaged: true` reports:

```
git diff --cached --no-ext-diff --no-color
git diff HEAD --no-ext-diff --no-color     <- never executed
git diff --no-ext-diff --no-color
git ls-files --others --exclude-standard -z
```

The second command was never run, and would fail if it were, because HEAD does
not exist.

## Steps to Reproduce

1. `git init repo && cd repo && echo a > a.txt && git add a.txt`
2. Call `getDiff(cwd, { includeUnstaged: true })`.
3. The returned `commands` contains `git diff HEAD …`.

## Root Cause

`src/git/CommitMessageGenerator.ts:484-487` seeds `commands` with
`gitDiffCommand(...(options.includeUnstaged ? ["HEAD"] : []))` before the code
checks for HEAD (`rev-parse --verify --quiet HEAD`, lines ~494-507). The unborn
branch then pushes `gitDiffCommand()` as well (line ~520), but never removes
the HEAD entry it did not run.

## Suggested Fix

Seed `commands` with only `stagedCommand`, then push each command where it
actually runs: `gitDiffCommand("HEAD")` inside the `hasHead` branch, and
`gitDiffCommand()` in the unborn branch and in the non-`includeUnstaged`
branch. Add a unit test that asserts the exact `commands` list for both an
unborn repo and a repo with a commit, with `includeUnstaged: true`.
