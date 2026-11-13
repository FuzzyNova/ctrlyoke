# A fork PR branch without a remote-tracking ref is classified local and offered two-way Sync

- **Found:** 2026-11-12 by the bug-hunt workflow's final step (claude-cli subagent), Git behavior reproduced in a scratch repo
- **Area:** `src/utils/GitUtils.ts` (`getBranchUpstreamStatus`), `src/utils/WorktreeComparison.ts` (`classifyWorktreeComparison`), `src/core/orchestration/WorktreeManager.ts` (`syncNamedWorktree`, worktree listing)
- **Resolution:** fixed in this commit

## Symptom

The 0.7.0 PR-branch work promises that "PR branches no longer offer two-way **Sync** or
appear in **Sync All**, avoiding merging unreviewed PR work into the source checkout"
(`CHANGELOG.md`, and "Sync All" in `docs/workflows/worktrees.md`). A branch checked
out from someone else's fork is still classified **local**, though. Its row offers
**Sync**, it is included in **Sync All**, and the server-side refusal in
`syncNamedWorktree` doesn't fire. Sync merges the fork's unreviewed commits into the
user's own branch (e.g. `main`).

## Steps to Reproduce

1. In a repo, create a branch configured the way `gh pr checkout` configures a fork PR:
   - `git config branch.pr-1.remote https://github.com/fork/repo.git`
   - `git config branch.pr-1.merge refs/heads/feature`
     or, for a PR fetched through the base repo:
   - `git config branch.pr-2.remote origin`
   - `git config branch.pr-2.merge refs/pull/2/head`
2. `git for-each-ref --format='[%(upstream)][%(upstream:short)][%(upstream:track)]' refs/heads/pr-1 refs/heads/pr-2`
   prints `[][][]` for both. Git has no remote-tracking ref to point at, so the
   upstream atoms are empty.
3. Use either branch as a named worktree (`worktree.directory`) and open Settings →
   Worktrees. The row reads as a local branch with **Sync with &lt;branch&gt;**, and
   **Sync All** includes it.

## Root Cause

`getBranchUpstreamStatus` (#selection:src/utils/GitUtils.ts:2252-2271) reads only
`%(upstream:short)`, which is empty unless the upstream resolves to a remote-tracking
ref. `classifyWorktreeComparison` (#selection:src/utils/WorktreeComparison.ts:7-21)
treats "no upstream" as `LOCAL`. Both the dashboard (`worktreeStatus.ts`,
`isSyncEligible` in `WorktreesSection.tsx`) and the server guard in `syncNamedWorktree`
(#selection:src/core/orchestration/WorktreeManager.ts:1128-1145) inherit that answer.

## Suggested Fix

When `%(upstream)` is empty, also read `git config --get branch.<b>.merge` (and
`.remote`). A branch with a configured `merge` whose upstream doesn't resolve has a
real upstream Git can't count against, so return it as an upstream (label e.g.
`<remote>/<merge without refs/heads/>`, or the merge ref for `refs/pull/*`) and let it
classify as `PR`. The listing at `WorktreeManager.ts` around line 1976 must then skip
`getAheadBehind` for that label (it isn't a ref) rather than fail, so the row shows the
PR status without counts. Add unit tests for both configurations above in the
`GitUtils`/`WorktreeComparison` tests and a `syncNamedWorktree` refusal test.

A branch fetched by hand with `git fetch origin pull/N/head:pr-N` and no upstream config
at all stays indistinguishable from a local branch; that is out of scope.
