# A bare-name worktree `directory` can match, and then switch, the main checkout

- **Found:** 2026-11-12 by the bug-hunt workflow's final step (claude-cli subagent), reproduced with bundled `resolveWorktreeDirectory` against a temp repo
- **Area:** `src/utils/WorktreeUtils.ts` (`resolveWorktreeDirectory`), `src/core/orchestration/WorktreeManager.ts` (`listWorktreeDirectories`)
- **Severity:** medium

## Symptom

`docs/workflows/worktrees.md` ("A bare name … reuses the registered linked worktree…"), the
checkout-slots plan, and `listWorktreeDirectories`' doc comment all say a bare name matches
a *linked* worktree. The bare-name filter only excludes `bare` entries and the source
checkout, though. When ctrlyoke runs from a linked worktree, the repository's **main**
checkout is a valid match whenever its folder name equals the bare name. The dashboard
offers it as a completion too.

If the main checkout is clean, the named resolution takes a lease on it and runs
`git switch <run branch>` in the user's main checkout, and nothing switches it back. A bare
name needs no trust approval, so a workspace-scope `defaults.worktree` can trigger this
without asking.

## Steps to Reproduce

1. `git init myrepo` on `main`, then `git worktree add -b feat ../myrepo.worktrees/feat`.
2. From the `feat` checkout, call
   `resolveWorktreeDirectory(<feat path>, "myrepo", <git worktree list of feat>, <common dir>, <root>)`.
3. It returns `{ kind: "existing", entry: { worktreePath: ".../myrepo", branchName: "main" } }`.

## Root Cause

Nothing excludes the main worktree, which is the first entry of `git worktree list`. See
the match filter at #selection:src/utils/WorktreeUtils.ts:168-173 and the completion
filter in `listWorktreeDirectories` (#selection:src/core/orchestration/WorktreeManager.ts:692-700),
which excludes only `repositoryRoot`, the *current* checkout's top level.

## Suggested Fix

Exclude the main worktree from bare-name matches and from `listWorktreeDirectories`. That is
the entry whose path is the common git dir's parent (or the first `git worktree list` entry;
`listGitWorktrees` may already expose it). Leave path-form directories as they are, so
pointing a path at the main checkout explicitly stays a separate decision. Add a
`src/test/unit/WorktreeUtils.test.ts` case that runs from a linked worktree and uses the main
checkout's folder name as the bare name.
