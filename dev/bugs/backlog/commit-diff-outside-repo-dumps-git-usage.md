# Commit-message diff outside a git repo fails with git's usage text, not the not-a-repo fallback

- **Found:** 2026-10-15 by bug-hunt final step (claude-cli)
- **Area:** `src/git/CommitMessageGenerator.ts`
- **Severity:** low

## Symptom

Running `ctrlyoke commit` in a directory that is not a git repository prints
`Error: Command failed: git diff --cached --no-ext-diff` followed by about 130
lines of git's `git diff --no-index` usage text. The not-a-repository handling
written for this case never runs. Hosted generation hits the same error when it
falls back to a `workspaceRoot` that is not a repo.

## Steps to Reproduce

1. `cd` to an empty temp directory that is not inside a git repo.
2. Run `ctrlyoke commit`.
3. Observed: git usage dump. Expected: a short "Not a git repository" error,
   or the tolerant null result the guards intend.

## Root Cause

`isNotGitRepositoryError` (~208–216) matches only
`/fatal: not a git repository/`. Outside a repo:

- `git diff --cached --no-ext-diff` exits 129 with
  `error: unknown option 'cached'` plus usage.
- Plain `git diff` exits 129 with `warning: Not a git repository. Use --no-index …`.
- Only `git ls-files` prints `fatal: not a git repository`.

So the first diff call in `getDiff()` (~295–316) throws before any guard can
match. No test covers a non-repo `cwd`.

## Suggested Fix

At the top of `getDiff()`, resolve the repo once (the existing `repoToplevel`
helper). If `cwd` is not in a repo, throw a clear "Not a git repository: <cwd>"
error that `ctrlyoke commit` prints cleanly, then remove the stderr-regex
guards that can no longer fire. Add a test with a non-repo temp directory.
