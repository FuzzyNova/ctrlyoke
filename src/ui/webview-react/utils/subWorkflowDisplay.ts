import {
  OUTPUT_HISTORY_KINDS,
  SUB_WORKFLOW_DASHBOARD_LABELS,
  WORKTREE_MERGE_OUTCOMES,
} from "@root/types/DashboardConstants";
import type { OrderedHistoryEntry } from "@root/types/OutputHistoryTypes";
import {
  isPromptStep,
  type PromptStep,
  type SubWorkflowOutput,
  type SubWorkflowStep,
} from "@root/types/CtrlYokeTypes";

/** A lane's merge that did not land cleanly (D4e): a badge label and its reason. */
export interface SubWorkflowMergeWarning {
  label: string;
  reason: string;
}

/**
 * The warning for a settled child's merge result, or `undefined` for a clean
 * merge or no merge at all. A non-clean merge does not fail the step (D4e), so
 * this is the only place the row and the output area learn it went wrong.
 */
export function getSubWorkflowMergeWarning(
  worktree: SubWorkflowOutput["worktree"]
): SubWorkflowMergeWarning | undefined {
  switch (worktree?.mergeOutcome) {
    case WORKTREE_MERGE_OUTCOMES.CONFLICT: {
      const files = worktree.conflictFiles?.length
        ? ` ${SUB_WORKFLOW_DASHBOARD_LABELS.conflictFiles}: ${worktree.conflictFiles.join(", ")}`
        : "";
      return {
        label: SUB_WORKFLOW_DASHBOARD_LABELS.mergeConflict,
        reason: `${SUB_WORKFLOW_DASHBOARD_LABELS.mergeConflictReason}${files}`,
      };
    }
    case WORKTREE_MERGE_OUTCOMES.BLOCKED:
      return {
        label: SUB_WORKFLOW_DASHBOARD_LABELS.mergeBlocked,
        reason: SUB_WORKFLOW_DASHBOARD_LABELS.mergeBlockedReason,
      };
    case WORKTREE_MERGE_OUTCOMES.ABORT_FAILED:
      return {
        label: SUB_WORKFLOW_DASHBOARD_LABELS.mergeAbortFailed,
        reason: SUB_WORKFLOW_DASHBOARD_LABELS.mergeAbortFailedReason,
      };
    default:
      return undefined;
  }
}

/** The prompt step an inline definition wraps, or `undefined` for a file or an inline script. */
export function getInlinePromptStep(
  step: SubWorkflowStep
): PromptStep | undefined {
  return typeof step.workflow !== "string" && isPromptStep(step.workflow)
    ? step.workflow
    : undefined;
}

/** True when an inline definition declares its own worktree (a lane). */
export function hasInlineWorktree(step: SubWorkflowStep): boolean {
  if (typeof step.workflow === "string") return false;
  const worktree = step.workflow.worktree;
  return worktree !== undefined && worktree !== false;
}

/**
 * The most recent settlement recorded for a child run. A continued child
 * settles once per execution, and only the latest describes its merge.
 */
export function findLatestSubWorkflowSettlement(
  entries: readonly OrderedHistoryEntry[],
  childRunRef: string
): SubWorkflowOutput | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (
      entry.kind === OUTPUT_HISTORY_KINDS.SUB_WORKFLOW &&
      entry.subWorkflowOutput.childRunRef === childRunRef
    ) {
      return entry.subWorkflowOutput;
    }
  }
  return undefined;
}
