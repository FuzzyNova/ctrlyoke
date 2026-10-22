import type { WorktreeManagementEntry } from "@root/types/WebviewMessageTypes";
import {
  WORKTREE_MERGE_READINESS,
  type WorktreeMergeReadiness,
} from "@root/types/DashboardConstants";

type WorkingTreeCounts = NonNullable<WorktreeManagementEntry["workingTree"]>;
type ChangeCounts = WorkingTreeCounts["staged"];

export function totalChanges(counts: ChangeCounts): number {
  return counts.added + counts.modified + counts.deleted;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Whether the worktree's branch can merge into the source checkout's branch
 * as-is. Uncommitted work outranks commit counts: those changes would not
 * travel with a merge. Undefined when Git status was unavailable, and for the
 * source checkout when it is clean (it has nothing to merge into).
 */
export function resolveWorktreeMergeReadiness(
  entry: Pick<WorktreeManagementEntry, "workingTree" | "sourceComparison">
): WorktreeMergeReadiness | undefined {
  const { workingTree, sourceComparison } = entry;
  if (!workingTree) return undefined;
  if (workingTree.conflicted > 0) return WORKTREE_MERGE_READINESS.CONFLICTED;
  if (
    totalChanges(workingTree.staged) + totalChanges(workingTree.unstaged) >
    0
  ) {
    return WORKTREE_MERGE_READINESS.UNCOMMITTED;
  }
  if (!sourceComparison) return undefined;
  if (sourceComparison.ahead > 0) return WORKTREE_MERGE_READINESS.READY;
  return sourceComparison.behind > 0
    ? WORKTREE_MERGE_READINESS.BEHIND
    : WORKTREE_MERGE_READINESS.UP_TO_DATE;
}

/** Plain-language reading of the posh-git status, for its tooltip and accessible name. */
export function describeWorktreeStatus(
  entry: Pick<
    WorktreeManagementEntry,
    "branchName" | "workingTree" | "sourceComparison"
  >,
  sourceBranch: string | null | undefined
): string {
  const parts = [entry.branchName ?? "Detached HEAD"];
  const { sourceComparison, workingTree } = entry;
  if (sourceComparison && sourceBranch) {
    const { ahead, behind } = sourceComparison;
    parts.push(
      ahead === 0 && behind === 0
        ? `same commits as ${sourceBranch}`
        : `${plural(ahead, "commit")} ahead of ${sourceBranch}, ${behind} behind`
    );
  }
  if (workingTree) {
    const staged = totalChanges(workingTree.staged);
    const unstaged = totalChanges(workingTree.unstaged);
    parts.push(
      staged + unstaged === 0
        ? "no uncommitted changes"
        : `${staged} staged and ${unstaged} unstaged ${unstaged + staged === 1 ? "change" : "changes"}`
    );
    if (workingTree.conflicted > 0) {
      parts.push(plural(workingTree.conflicted, "conflicted file"));
    }
  }
  return parts.join(" — ");
}
