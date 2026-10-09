# Managed worktree landing is blocked when the agent committed all of its own work

- **Found:** 2026-10-09 by Claude (WORKFLOW_STEP_PLAN refinement review)
- **Area:** `src/core/orchestration/WorktreeManager.ts` (`completeManagedRun`)
- **Severity:** medium

## Symptom

A managed-worktree run whose agent runs `git commit` itself, leaving a clean worktree, settles
as `blocked` with "Managed branch changed without a ctrlyoke landing; refusing to overwrite its
identity." The branch is not landed, and `merge: true` never runs. The same run lands and merges
normally if the agent leaves even one uncommitted change.

## Steps to Reproduce

1. Run a workflow with `worktree: { mode: managed, merge: true }` whose prompt tells the agent to
   commit its changes.
2. The agent commits everything; the worktree is clean at settlement.
3. Settlement reports `blocked`; no merge happens.

## Root Cause

`completeManagedRun` (`WorktreeManager.ts` ~735-759):

- auto-commits if `hasUncommittedChanges`;
- returns no-change if HEAD equals the watermark;
- otherwise `if (!changed) return blocked(...)`.

So "HEAD moved past the watermark on the recorded branch" is accepted when ctrlyoke also
committed something, and rejected when it didn't. Identity is already checked earlier by
`validateManagedCheckoutIdentity` (still attached to the recorded branch, ref consistent), which
is the protection `WORKTREE_SUPPORT_PLAN.md` describes against detach/switch/reset. A
fast-forward commit by the agent on the recorded branch passes that check, yet is blocked here.

## Suggested Fix

Confirm intent with the worktree design owner first. If agent commits on the recorded branch
are legitimate (they are common for coding agents), drop the `!changed` block. Instead, require
`committedHead` to descend from the watermark (`git merge-base --is-ancestor`), which rejects a
reset or rewritten history while accepting forward commits. Land with the same
`changedFileCount` computation.

This matters for `dev/backlog/WORKFLOW_STEP_PLAN.md`: children with `merge: true` that commit
their own work would silently fail to merge back before the parent's next wave.
