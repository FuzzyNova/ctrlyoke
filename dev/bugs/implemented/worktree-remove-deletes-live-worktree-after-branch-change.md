# "Remove" on a managed worktree `rm -rf`s it, uncommitted work included, once its HEAD leaves the recorded branch

- **Found:** 2026-10-01 by bug-hunt final step (claude-cli), reproduced with the compiled `WorktreeManager` against a throwaway repo
- **Area:** `src/core/orchestration/WorktreeManager.ts` (`applyManagementAction` ~2000-2039, `getManagementStateIn` ~1800-1857)
- **Resolution:** fixed in this commit

## Symptom

A managed worktree whose HEAD no longer points at its recorded branch gets
deleted outright by a non-force **Remove**: dirty files, untracked files, and
any live run inside it. This happens after a detach (mid-rebase,
`git switch --detach`) or after switching to another branch. Neither
`git worktree remove`'s dirty-tree refusal nor the live-lease check runs.

## Steps to Reproduce

1. Create a managed worktree for branch `wt-a`.
2. In it: `git switch --detach`, then create `precious.txt`.
3. Call `applyManagementAction({ action: REMOVE, ... })` for that record. The
   dashboard row may still offer Remove if it was rendered before the detach.
4. The directory, `precious.txt` included, is gone. `git worktree list` now
   shows the entry as `prunable`.

## Root Cause

`applyManagementAction` looks up the git entry by **branch and path**:

```ts
const entry = currentEntries.find((c) =>
  c.branchName === record.branchName && pathsEqual(c.worktreePath, record.worktreePath));
const inspections = entry ? await ExecutionRootLeaseManager.inspectLeases(record.worktreePath) : [];
...
if (!entry) {
  // "Git has already fully forgotten this worktree"
  if (await this.pathExists(record.worktreePath)) await fs.rm(record.worktreePath, { recursive: true, force: true });
```

A worktree that git still has registered at that path, but on a different or
detached HEAD, is treated as "forgotten". The lease check is skipped and the
directory is removed recursively.

`getManagementStateIn` makes the same branch+path match, so such a record is
shown as `directoryState: removed` while the directory still exists.
`reconcileBlockedManagedWorktrees` (~2868) already refuses to remove an
"ambiguous path" for this reason.

## Resolution

Git registration is now matched by worktree path alone and shared by state
listing and management actions. Existing paths are checked for live leases
before either Remove action. When Git still registers a path whose HEAD has
changed or detached, Remove uses `git worktree remove`: Git refuses a dirty
tree for non-force Remove, while Force remove applies the explicit force flag.
The lease check refuses both actions while a run is live. Recursive filesystem
cleanup is reserved for paths Git has fully forgotten, preserving the existing
leftover cleanup behavior for that case.

State listing associates a registered path with its managed ownership record
regardless of its current HEAD, so it stays a managed row with its recorded
branch identity and is not incorrectly shown as removed. The dashboard still
offers Remove and Force remove for that row, disables both when a live lease is
present, and hides branch cleanup while the current HEAD no longer matches the
recorded branch.

The WorktreeManager tests cover a dirty detached worktree, a live lease on a
detached worktree, and a detached worktree's management state. Existing tests
continue to cover cleanup of leftover directories after Git forgets the path.
