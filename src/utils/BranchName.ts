/**
 * Branch-name helpers with no Node dependencies, so the dashboard and the
 * engine read a named worktree's branch the same way.
 */

/** Strip a `refs/heads/` prefix: `refs/heads/feature` and `feature` name one branch. */
export function normalizeBranchName(branchName: string): string {
  return branchName.startsWith("refs/heads/")
    ? branchName.slice("refs/heads/".length)
    : branchName;
}

/**
 * The branch a named worktree's `branch` value selects, exactly as
 * `WorktreeManager` resolves it: trimmed, without a `refs/heads/` prefix.
 */
export function normalizeNamedWorktreeBranch(branch: string): string {
  return normalizeBranchName(branch.trim());
}
