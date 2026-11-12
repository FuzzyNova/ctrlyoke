import type { WorktreeManagementEntry } from "@root/types/WebviewMessageTypes";
import {
  WORKTREE_MERGE_READINESS,
  type WorktreeMergeReadiness,
} from "@root/types/DashboardConstants";
import { pluralize } from "@utils/string";
import { classifyWorktreeComparison } from "@root/utils/WorktreeComparison";
import { WORKTREE_COMPARISON_KINDS } from "@root/types/DashboardConstants";
import type { WorktreeComparisonKind } from "@root/utils/WorktreeComparison";

type WorkingTreeCounts = NonNullable<WorktreeManagementEntry["workingTree"]>;
type ChangeCounts = WorkingTreeCounts["staged"];

export function totalChanges(counts: ChangeCounts): number {
  return counts.added + counts.modified + counts.deleted;
}

/**
 * Whether the worktree's branch can merge into the source checkout's branch
 * as-is. Uncommitted work outranks commit counts: those changes would not
 * travel with a merge. Undefined when Git status was unavailable, and for the
 * source checkout when it is clean (it has nothing to merge into).
 */
export function resolveWorktreeMergeReadiness(
  entry: Pick<
    WorktreeManagementEntry,
    "workingTree" | "sourceComparison" | "upstream"
  >,
  comparisonKind: WorktreeComparisonKind = WORKTREE_COMPARISON_KINDS.LOCAL
): WorktreeMergeReadiness | undefined {
  const { workingTree, sourceComparison, upstream } = entry;
  if (!workingTree) return undefined;
  if (workingTree.conflicted > 0) return WORKTREE_MERGE_READINESS.CONFLICTED;
  if (
    totalChanges(workingTree.staged) + totalChanges(workingTree.unstaged) >
    0
  ) {
    return WORKTREE_MERGE_READINESS.UNCOMMITTED;
  }
  if (comparisonKind === WORKTREE_COMPARISON_KINDS.PR) {
    if (upstream?.gone) return WORKTREE_MERGE_READINESS.UPSTREAM_GONE;
    if (upstream?.ahead === undefined || upstream.behind === undefined)
      return undefined;
    if (upstream.ahead > 0) return WORKTREE_MERGE_READINESS.UNPUSHED;
    if (upstream.behind > 0) return WORKTREE_MERGE_READINESS.BEHIND;
    return WORKTREE_MERGE_READINESS.PUSHED;
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
    "branchName" | "workingTree" | "sourceComparison" | "upstream"
  >,
  sourceBranch: string | null | undefined,
  comparisonKind: WorktreeComparisonKind = WORKTREE_COMPARISON_KINDS.LOCAL
): string {
  const parts = [entry.branchName ?? "Detached HEAD"];
  const { sourceComparison, workingTree } = entry;
  if (comparisonKind === WORKTREE_COMPARISON_KINDS.PR && entry.upstream) {
    const { ahead, behind, gone, label } = entry.upstream;
    parts.push(
      gone
        ? `upstream ${label} is gone`
        : ahead === undefined || behind === undefined
          ? `compared with upstream ${label}`
          : ahead === 0 && behind === 0
            ? `same commits as upstream ${label}`
            : `${pluralize(ahead, "commit")} ahead of upstream ${label}, ${behind} behind`
    );
  } else if (sourceComparison && sourceBranch) {
    const { ahead, behind } = sourceComparison;
    parts.push(
      ahead === 0 && behind === 0
        ? `same commits as ${sourceBranch}`
        : `${pluralize(ahead, "commit")} ahead of ${sourceBranch}, ${behind} behind`
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
      parts.push(pluralize(workingTree.conflicted, "conflicted file"));
    }
  }
  return parts.join(" — ");
}

export function isPullRequestWorktree(
  entry: Pick<WorktreeManagementEntry, "upstream">,
  sourceBranch: string | null | undefined,
  sourceUpstream?: string
): boolean {
  return (
    classifyWorktreeComparison({
      upstream: entry.upstream,
      sourceBranch: sourceBranch ?? null,
      sourceUpstream,
    }) === WORKTREE_COMPARISON_KINDS.PR
  );
}

/** Remove the deterministic 12-hex suffix used on ctrlyoke worktree directories. */
export function stripWorktreeDirectoryHashSuffix(name: string): string {
  return name.replace(/-[a-f\d]{12}$/i, "");
}
