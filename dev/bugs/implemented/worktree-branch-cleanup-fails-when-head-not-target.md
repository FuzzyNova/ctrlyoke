# Worktree branch cleanup fails for merged branches when the source checkout isn't on the target branch

- **Found:** 2026-09-28 by lots-of-bug-fixes final step (Claude)
- **Area:** `src/core/orchestration/WorktreeManager.ts` (branch cleanup, around lines 2087-2102), `src/utils/GitUtils.ts` (`deleteLocalBranch`)
- **Resolution:** fixed in this commit

## Symptom

ctrlyoke offers "clean up branch" for a managed branch once it has proven that branch is merged
into the record's `targetBranch`. Bulk cleanup (`WorktreesSection.tsx`, which sends no `confirmed`)
then fails with git's `error: the branch '<name>' is not fully merged` whenever the source checkout's
HEAD is on some other branch. So the branches ctrlyoke calls safe are exactly the ones it fails to
delete.

## Steps to Reproduce

Verified by an agent with real git: `managed` is merged into `main` while HEAD is on `other`.
`git branch -d -- managed` exits 1 with "not fully merged".

## Root Cause

Eligibility is computed with `isCommitAncestor(branch, record.targetBranch)`. When
`options.confirmed` isn't set, the deletion uses `deleteLocalBranch(..., force = false)`, which is
`git branch -d`. Git checks whether the branch is merged into **HEAD** (or its upstream), not into
`targetBranch`.

## Suggested Fix

After `getBranchCleanupEligibility` reports `eligible: true` (and the tip matches the last verified
tip, which the code already checks), delete with `-D`: ctrlyoke has already proven the merge
against the right branch. Keep `-D` behind explicit confirmation for non-eligible branches as today.
Add a real-git test where HEAD is on a third branch.
