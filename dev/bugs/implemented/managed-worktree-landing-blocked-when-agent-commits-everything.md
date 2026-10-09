# Managed worktree landing is blocked when the agent committed all of its own work

- **Found:** 2026-10-09 by Claude (WORKFLOW_STEP_PLAN refinement review)
- **Area:** `src/core/orchestration/WorktreeManager.ts` (`completeManagedRun`)
- **Resolution:** fixed in this commit

## Symptom

A managed-worktree run whose agent runs `git commit` itself settles as `blocked`. The branch is
not landed, and `merge: true` never runs. Ctrlyoke only lands a branch whose tip it committed itself.

## Steps to Reproduce

1. Run a workflow with `worktree: { mode: managed, merge: true }` whose prompt tells the agent to
   commit its changes.
2. The agent commits (all or part of) its work on the managed branch.
3. Settlement reports `blocked` with "Managed branch ref moved since ctrlyoke last verified it."
   No merge happens.

## Root Cause

(Corrected 2026-10-09 during the bug-drain review. The original analysis blamed the
`if (!changed)` block, but settlement never reaches it.)

`completeManagedRun` (`WorktreeManager.ts` ~701) first calls `validateManagedCheckoutIdentity`,
which requires `branchTip === record.lastVerifiedBranchTip` (~1140). `lastVerifiedBranchTip` is
written only at creation (`baseCommit`) and at landing, so *any* agent commit, even with leftover
uncommitted changes, moves the tip and blocks settlement there. The later
`if (!changed) return blocked("Managed branch changed without a ctrlyoke landing ...")` (~755) is
effectively unreachable: `getManagedWorktreeWatermark(record)` equals `lastVerifiedBranchTip` in
every persisted record shape, so HEAD != watermark has already failed the identity check.

## Suggested Fix

Decision (orchestrator, pre-release): agent commits on the recorded branch are legitimate. Finalization
step 5 of `dev/implemented/WORKTREE_SUPPORT_PLAN.md` already speaks of "user/agent changes".
Reset, rewrite, detach, and branch switches must still be blocked.

- Give the settlement-time identity check a forward-progress mode: still require the
  worktree to be attached to `info.branchName`, HEAD == branch ref, no Git operation in
  progress, and no unsafe runtime paths, but accept a branch tip that **descends from**
  `record.lastVerifiedBranchTip` (`isCommitAncestor` in `src/git/`), not only an equal tip.
- Remove the dead `!changed` block. Land with the same `changedFileCount` (watermark..HEAD).
- Make `autoCommitted` in the result reflect whether ctrlyoke actually committed (it is
  hard-coded `true` today).
- Audit every other caller of `validateManagedCheckoutIdentity` and every
  `=== record.lastVerifiedBranchTip` check. Settlement and recovery of an interrupted run
  should accept forward agent commits. Post-settlement branch cleanup and cleanup eligibility
  (after landing has refreshed `lastVerifiedBranchTip`) keep strict equality.

This matters for `dev/backlog/WORKFLOW_STEP_PLAN.md`: children with `merge: true` that commit
their own work would silently fail to merge back before the parent's next wave.
