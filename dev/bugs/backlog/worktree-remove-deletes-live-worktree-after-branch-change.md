# "Remove" on a managed worktree `rm -rf`s it, uncommitted work included, once its HEAD leaves the recorded branch

- **Found:** 2026-10-01 by bug-hunt final step (claude-cli), reproduced with the compiled `WorktreeManager` against a throwaway repo
- **Area:** `src/core/orchestration/WorktreeManager.ts` (`applyManagementAction` ~2000-2039, `getManagementStateIn` ~1800-1857)
- **Severity:** high (data loss)

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

## Suggested Fix

- Match the git entry by **path alone** to decide whether git still knows the
  worktree. Only treat it as forgotten (and `fs.rm` leftovers) when no
  registered worktree has that path.
- Inspect leases whenever the path exists, not only when an entry matched.
- When the path is registered but on another branch or detached, take the
  normal `removeWorktree` path. Its dirty-tree refusal and the force flag then
  apply. Or refuse with a clear error, consistent with reconciliation.
- Make `getManagementStateIn` classify the directory by path, so the row does
  not report `removed` for a directory that exists.
- Tests in the existing WorktreeManager suite: detached HEAD plus a dirty file
  → non-force Remove does not delete it; a live lease → refused; a genuinely
  forgotten path → leftovers still cleared.
