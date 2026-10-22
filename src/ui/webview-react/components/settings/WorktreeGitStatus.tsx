import type { WorktreeManagementEntry } from "@root/types/WebviewMessageTypes";
import {
  WORKTREE_MERGE_READINESS,
  type WorktreeMergeReadiness,
} from "@root/types/DashboardConstants";
import { SCM_CHANGE_COUNT_COLOR_CLASS } from "@utils/scmStatus";
import {
  describeWorktreeStatus,
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
 * exist and `~` means only staged ones do. Arrows compare against the source
 * checkout's branch rather than an upstream, because that is the branch Sync
 * and a merge target here.
 */
export function WorktreeGitStatus({
  entry,
  sourceCheckoutBranch,
  branchColorClass,
}: {
  entry: WorktreeManagementEntry;
  sourceCheckoutBranch: string | null | undefined;
  branchColorClass: string;
}) {
  const { workingTree, sourceComparison } = entry;
  const stagedCount = workingTree ? totalChanges(workingTree.staged) : 0;
  const unstagedCount = workingTree ? totalChanges(workingTree.unstaged) : 0;
  const readiness = resolveWorktreeMergeReadiness(entry);
  const readinessDisplay = readiness ? READINESS_DISPLAY[readiness] : undefined;
  const description = describeWorktreeStatus(entry, sourceCheckoutBranch);

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
        {sourceComparison &&
          (sourceComparison.ahead === 0 && sourceComparison.behind === 0 ? (
            <span className="text-description-fg"> ≡</span>
          ) : (
            <>
              {sourceComparison.behind > 0 && (
                <span className={SCM_CHANGE_COUNT_COLOR_CLASS.deleted}>
                  {" "}
                  ↓{sourceComparison.behind}
                </span>
              )}
              {sourceComparison.ahead > 0 && (
                <span className={SCM_CHANGE_COUNT_COLOR_CLASS.added}>
                  {" "}
                  ↑{sourceComparison.ahead}
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
          {readinessDisplay.label(sourceCheckoutBranch ?? "checkout")}
        </span>
      )}
    </div>
  );
}
