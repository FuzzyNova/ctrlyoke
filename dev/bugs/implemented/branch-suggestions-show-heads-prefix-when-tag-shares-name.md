# Branch suggestions show `heads/<name>` when a tag shares the branch's name

- **Found:** 2026-11-25 by bug-hunt workflow final step (Claude, code review of e2356239f)
- **Area:** `src/utils/GitUtils.ts` (`listLocalBranches`), `src/completions/BranchCompletionHelpers.ts`
- **Resolution:** fixed in this commit

## Symptom

In a repository that has a tag with the same name as a local branch (for example a
`release` branch and a `release` tag), the dashboard's Git branch suggestions list the
branch as `heads/release`. The prefix filter compares typed text against that value, so
typing `rel` does not find it. If you pick the suggestion as a named worktree's
`branch`, ctrlyoke inserts `heads/release`. That isn't an existing branch
(`refs/heads/heads/release`), so the run creates a new branch called `heads/release`
from the base instead of checking out the existing `release` branch.

## Steps to Reproduce

1. `git init`, make one commit, then `git branch release && git tag release`.
2. `git for-each-ref --format='%(refname:short)' refs/heads` prints `master` and
   `heads/release`. That is the exact format `listLocalBranches` uses.
3. In the dashboard, open a named worktree's branch field and type `rel`: nothing
   matches. Clear the field and pick `heads/release`.
4. Run the workflow: a new branch `heads/release` is created
   (`WorktreeManager.ts` ~1730 `addWorktree(... createBranch: !localBranchCommit)`).

## Root Cause

`listLocalBranches` (`src/utils/GitUtils.ts` ~2219) formats each ref with
`%(refname:short)`. Git's `:short` produces the shortest _unambiguous_ name, so when
`refs/tags/<name>` (or `refs/remotes/<name>`) also exists it returns `heads/<name>`.
Every consumer then treats the result as a branch name: `getBranchCompletions` uses
it as `label` and `insertText`, and the worktree code looks it up under `refs/heads/`.
This predates e2356239f; that commit kept the same field.

## Suggested Fix

Format the name with `%(refname:lstrip=2)`, which always strips just `refs/heads/`.
Add a `GitUtils` test that creates a branch and a tag with the same name and checks
that `listLocalBranches` returns the bare name.
