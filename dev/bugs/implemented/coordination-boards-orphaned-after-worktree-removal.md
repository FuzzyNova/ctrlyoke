# Coordination boards and execution leases outlive their worktree forever

- **Found:** 2026-10-14 by Claude (auditing coordination cleanup)
- **Area:** `src/core/orchestration/ExecutionRootScope.ts`, `src/core/orchestration/ExecutionRootCoordinationStore.ts`, `src/core/orchestration/WorktreeManager.ts`
- **Resolution:** fixed in this commit. `sweepOrphanedScopeStorage()` runs after every
  managed removal (`WorktreeManager.removeCheckout`) and in the extension's periodic orphan
  sweep, which also catches worktrees removed with plain `git worktree remove`.

## Symptom

`<git-common-dir>/ctrlyoke/coordination/<scopeHash>/` (and the matching
`execution-leases/<scopeHash>/`) is never deleted. On this repository on 2026-10-14
there were 10 coordination scopes, and 7 of them belonged to worktrees that no longer
exist (`just-say-hi-in-worktree-*`, an old `small-feature-*`). Their boards still hold
unresolved claims and notes more than a month old, which is well past
`maxEntryAgeDays` (7).

## Steps to Reproduce

1. Run a workflow in a managed worktree where a step calls `claim_paths` or `post_note`.
2. Let the run land or discard it, so the worktree is removed.
3. `ls .git/ctrlyoke/coordination/*/scope.json`: the removed worktree's scope is still
   there, with its board unchanged.

## Root Cause

Retention (`removeOldNotes`, `compactDepartedParticipants`, `trimNotesToCaps`) runs
only inside `transaction.append()`, so a board is compacted only when something writes
to it. A scope whose execution root is gone never gets another write. Nothing in
worktree removal touches `scopeStorageRoot(...)`; the `ExecutionRootScope.ts` comment
even calls outliving the worktree "incidental for the board".

## Suggested Fix

Remove the scope directories (`coordination/` and `execution-leases/`) whenever the
worktree is removed. When ctrlyoke starts, it can also sweep any scope whose
`scope.json` identity names a `.git/worktrees/<name>` directory that no longer exists.
The data does not need to survive either case: claims and leases name an execution
root that is gone, and the notes are only advisory.
