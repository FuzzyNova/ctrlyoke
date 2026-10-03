# Hosted workspace viewer commit, push, pull and checkout are killed after 10 s

- **Found:** 2026-10-03 by the more-bug-backlog2 workflow final step (claude-cli)
- **Area:** `src/server/HostedWorkspaceViewerService.ts` (`GIT_TIMEOUT_MS`, `commit`, `push`, `pull`, `checkoutCommit`, `checkoutBranch`)
- **Resolution:** fixed in this commit

## Symptom

The hosted dashboard's workspace viewer runs every git command with
`timeout: GIT_TIMEOUT_MS` (10 s, `HostedWorkspaceViewerService.ts:132`). That
includes the mutating commands that run user hooks or the network:

- `commit` (`git commit -m`, ~line 2036) runs `pre-commit` / `commit-msg`
  hooks. A husky + lint-staged setup, a typecheck, or a test run easily takes
  more than 10 s.
- `push` (~2049) runs `pre-push` hooks and talks to the remote.
- `pull` (~2106) fetches over the network and can run merge hooks.
- `checkoutCommit` / `checkoutBranch` (~2671 / ~2690) do a full checkout and
  run `post-checkout`. On a large tree, or on Windows with Defender scanning,
  that takes more than 10 s.

When the timer fires, Node SIGTERMs git. No commit is made, the changes stay
staged, and the hosted UI shows a raw `Command failed` error. A killed push or
pull leaves the user unsure what actually reached the remote. A killed checkout
can leave the working tree half switched.

This is the same defect as
`dev/bugs/implemented/git-mutating-commands-killed-by-10s-timeout.md`. Commit
556135b08 fixed it in `src/utils/GitUtils.ts`, adding
`GIT_MUTATION_TIMEOUT_MS = 5 * 60_000` and `getGitTimeoutMs(true)`, but the
hosted viewer service keeps its own 10 s constant and never got the fix.

## Steps to Reproduce

1. In a workspace repo, create `.git/hooks/pre-commit` containing `sleep 12`
   (on Windows, Git Bash runs it).
2. Enable the hosted server, open the hosted workspace viewer, stage a file,
   enter a message, and press Commit.
3. After about 10 s the request fails with `Command failed: git ... commit -m
   ...`. `git log` shows no new commit, and the file is still staged.

## Root Cause

`HostedWorkspaceViewerService.ts:132` declares a private
`const GIT_TIMEOUT_MS = 10_000;`, and every `execFileAsync("git", ...)` call in
the service uses it, mutating or not. The mutation-timeout policy in
`GitUtils.getGitTimeoutMs(true)` is not exported, so this file couldn't use it.

## Suggested Fix

- Single-source the timeout policy: export from `GitUtils` a way to get the
  mutation timeout (for example, export `getGitTimeoutMs`, or an exported
  `GIT_MUTATION_COMMAND_TIMEOUT_MS` next to the existing
  `GIT_COMMAND_TIMEOUT_MS`).
- Use it in the hosted service's `commit`, `push`, `pull`, `checkoutCommit`
  and `checkoutBranch`.
- Keep the 10 s timeout for read-only queries (`status`, `branch
  --show-current`, `rev-parse`, `cat-file`, diffs) and for single-path
  stage/unstage.
- Prefer replacing the private `GIT_TIMEOUT_MS` with the exported
  `GIT_COMMAND_TIMEOUT_MS`, so the hosted service has no private copy of either
  constant.
