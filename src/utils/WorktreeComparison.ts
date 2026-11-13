import { WORKTREE_COMPARISON_KINDS } from "../types/DashboardConstants";

export type WorktreeComparisonKind =
  (typeof WORKTREE_COMPARISON_KINDS)[keyof typeof WORKTREE_COMPARISON_KINDS];

/** Classify an upstream relative to the source checkout's branch and upstream. */
export function classifyWorktreeComparison(input: {
  upstream?: { label: string; gone: boolean; resolvable?: boolean };
  sourceBranch: string | null;
  sourceUpstream?: string;
}): WorktreeComparisonKind {
  const { upstream, sourceBranch, sourceUpstream } = input;
  if (
    !upstream ||
    upstream.label === sourceBranch ||
    upstream.label === sourceUpstream
  ) {
    return WORKTREE_COMPARISON_KINDS.LOCAL;
  }
  return WORKTREE_COMPARISON_KINDS.PR;
}
