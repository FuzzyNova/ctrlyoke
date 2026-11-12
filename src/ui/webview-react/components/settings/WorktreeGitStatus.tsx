import type { WorktreeManagementEntry } from "@root/types/WebviewMessageTypes";
import {
  WORKTREE_COMPARISON_KINDS,
  WORKTREE_MERGE_READINESS,
  type WorktreeMergeReadiness,
} from "@root/types/DashboardConstants";
import { SCM_CHANGE_COUNT_COLOR_CLASS } from "@utils/scmStatus";
import {
  describeWorktreeStatus,
  isPullRequestWorktree,
  resolveWorktreeMergeReadiness,
  totalChanges,
} from "@utils/worktreeStatus";

type ChangeCounts = NonNullable<
  WorktreeManagementEntry["workingTree"]
>["staged"];

const READINESS_DISPLAY: Record<
  WorktreeMergeReadiness,
  { label: (sourceBranch: string) => string; colorClass: string }
> = {
  [WORKTREE_MERGE_READINESS.CONFLICTED]: {
    label: () => "Merge conflicts",
    colorClass: SCM_CHANGE_COUNT_COLOR_CLASS.deleted,
  },
  [WORKTREE_MERGE_READINESS.UNCOMMITTED]: {
    label: () => "Uncommitted changes",
    colorClass: SCM_CHANGE_COUNT_COLOR_CLASS.modified,
  },
  [WORKTREE_MERGE_READINESS.READY]: {
    label: () => "Ready to merge",
    colorClass: SCM_CHANGE_COUNT_COLOR_CLASS.added,
  },
  [WORKTREE_MERGE_READINESS.BEHIND]: {
    label: (sourceBranch) => `Behind ${sourceBranch}`,
    colorClass: "text-description-fg",
  },
  [WORKTREE_MERGE_READINESS.UP_TO_DATE]: {
    label: () => "Up to date",
    colorClass: "text-description-fg",
  },
  [WORKTREE_MERGE_READINESS.UNPUSHED]: {
    label: () => "Unpushed commits",
    colorClass: SCM_CHANGE_COUNT_COLOR_CLASS.added,
  },
  [WORKTREE_MERGE_READINESS.PUSHED]: {
    label: () => "Pushed",
    colorClass: "text-description-fg",
  },
  [WORKTREE_MERGE_READINESS.UPSTREAM_GONE]: {
    label: () => "Upstream gone",
    colorClass: SCM_CHANGE_COUNT_COLOR_CLASS.deleted,
  },
};

function ChangeCountGroup({ counts }: { counts: ChangeCounts }) {
  return (
    <>
      {" "}
      <span className={SCM_CHANGE_COUNT_COLOR_CLASS.added}>
        +{counts.added}
      </span>{" "}
      <span className={SCM_CHANGE_COUNT_COLOR_CLASS.modified}>
        ~{counts.modified}
      </span>{" "}
      <span className={SCM_CHANGE_COUNT_COLOR_CLASS.deleted}>
        -{counts.deleted}
      </span>
    </>
  );
}

/**
 * posh-git style one-line status: `[branch ↓behind ↑ahead +a ~m -d | +a ~m -d !]`.
 * The index (staged) group comes first and the working-tree group second,
 * each shown only when non-empty; the trailing `!` means unstaged changes
 * exist and `~` means only staged ones do. PR branches compare with their
 * upstream; local branches compare with the source checkout branch.
 */
export function WorktreeGitStatus({
  entry,
  sourceCheckoutBranch,
  sourceCheckoutUpstream,
  branchColorClass,
}: {
  entry: WorktreeManagementEntry;
  sourceCheckoutBranch: string | null | undefined;
  sourceCheckoutUpstream?: string;
  branchColorClass: string;
}) {
  const { workingTree, sourceComparison } = entry;
  const isPr = isPullRequestWorktree(
    entry,
    sourceCheckoutBranch,
    sourceCheckoutUpstream
  );
  const comparison = isPr ? entry.upstream : sourceComparison;
  const stagedCount = workingTree ? totalChanges(workingTree.staged) : 0;
  const unstagedCount = workingTree ? totalChanges(workingTree.unstaged) : 0;
  const readiness = resolveWorktreeMergeReadiness(
    entry,
    isPr ? WORKTREE_COMPARISON_KINDS.PR : WORKTREE_COMPARISON_KINDS.LOCAL
  );
  const readinessDisplay = readiness ? READINESS_DISPLAY[readiness] : undefined;
  const description = describeWorktreeStatus(
    entry,
    sourceCheckoutBranch,
    isPr ? WORKTREE_COMPARISON_KINDS.PR : WORKTREE_COMPARISON_KINDS.LOCAL
  );

  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <span className="sr-only">{description}</span>
      <span
        className="font-mono text-xs whitespace-pre-wrap break-all"
        title={description}
        aria-hidden="true"
        data-testid="worktree-git-status"
      >
        <span className="text-description-fg">[</span>
        <span className={branchColorClass}>
          {entry.branchName ?? "(detached)"}
        </span>
        {comparison &&
          (isPr && entry.upstream?.gone ? (
            <span className={SCM_CHANGE_COUNT_COLOR_CLASS.deleted}> ×</span>
          ) : comparison.ahead === undefined ||
            comparison.behind === undefined ? null : comparison.ahead === 0 &&
            comparison.behind === 0 ? (
            <span className="text-description-fg"> ≡</span>
          ) : (
            <>
              {comparison.behind > 0 && (
                <span className={SCM_CHANGE_COUNT_COLOR_CLASS.deleted}>
                  {" "}
                  ↓{comparison.behind}
                </span>
              )}
              {comparison.ahead > 0 && (
                <span className={SCM_CHANGE_COUNT_COLOR_CLASS.added}>
                  {" "}
                  ↑{comparison.ahead}
                </span>
              )}
            </>
          ))}
        {workingTree && stagedCount > 0 && (
          <ChangeCountGroup counts={workingTree.staged} />
        )}
        {stagedCount > 0 && unstagedCount > 0 && (
          <span className="text-description-fg"> |</span>
        )}
        {workingTree && unstagedCount > 0 && (
          <ChangeCountGroup counts={workingTree.unstaged} />
        )}
        {workingTree && workingTree.conflicted > 0 && (
          <span className={SCM_CHANGE_COUNT_COLOR_CLASS.deleted}>
            {" "}
            !{workingTree.conflicted}
          </span>
        )}
        {unstagedCount > 0 ? (
          <span className={SCM_CHANGE_COUNT_COLOR_CLASS.deleted}> !</span>
        ) : stagedCount > 0 ? (
          <span className={SCM_CHANGE_COUNT_COLOR_CLASS.modified}> ~</span>
        ) : null}
        <span className="text-description-fg">]</span>
      </span>
      {readinessDisplay && (
        <span className={`text-xs ${readinessDisplay.colorClass}`}>
          {readiness === WORKTREE_MERGE_READINESS.BEHIND
            ? readinessDisplay.label(
                isPr
                  ? (entry.upstream?.label ?? "upstream")
                  : (sourceCheckoutBranch ?? "checkout")
              )
            : readinessDisplay.label(sourceCheckoutBranch ?? "checkout")}
        </span>
      )}
    </div>
  );
}
