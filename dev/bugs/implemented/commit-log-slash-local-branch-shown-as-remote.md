# Commit history labels local branches containing `/` as remote branches

- **Found:** 2026-09-27 by the long-running bug-fix workflow final step (claude-cli)
- **Area:** `src/server/HostedWorkspaceViewerService.ts` (`classifyRefNames`)
- **Resolution:** fixed in this commit

## Symptom

In the hosted viewer's commit history, a local branch such as `feature/login` or
`fix/foo` is shown with the remote-branch (cloud) pill, and can be hidden as a
"redundant remote" when a local branch sits at the same commit
(`WorkspaceCommitHistoryPane.tsx`). Reproduced in a repo with **no remotes**, on
`feature/login`: `getCommitLog()` returned
`refs: [{name:"feature/login",type:"remoteBranch"},{name:"main",type:"localBranch"}]`,
while `git log -1 --format=%D` is `HEAD -> feature/login, main`.

## Steps to Reproduce

1. `git switch -c feature/login` in a workspace repo, make a commit.
2. Open the hosted viewer's commit history.
3. `feature/login` renders as a remote branch.

## Root Cause

`classifyRefNames` (`HostedWorkspaceViewerService.ts:~337`) treats any `%D` ref name
containing `/` as `GIT_REF_LABEL_TYPES.REMOTE_BRANCH`. `%D` prints short names, so
`feature/login` and `origin/main` are indistinguishable. Existing tests only cover
single-segment local names and `origin/<branch>`.

## Suggested Fix

Ask git for full ref names (`git log --decorate=full` with `%D`, which yields
`refs/heads/…`, `refs/remotes/…`, `tag: refs/tags/…`, `HEAD -> refs/heads/…`) and
classify by prefix, stripping it for display. Keep the `<remote>/HEAD` skip (now
`refs/remotes/<remote>/HEAD`). Add tests for a local `feature/login`, a remote
`origin/feature/login`, a tag with a slash, and `HEAD -> feature/login`.
