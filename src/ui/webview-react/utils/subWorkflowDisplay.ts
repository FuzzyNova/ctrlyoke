import {
  OUTPUT_HISTORY_KINDS,
  SUB_WORKFLOW_DASHBOARD_LABELS,
  WORKTREE_MERGE_OUTCOMES,
  WORKTREE_MODES,
  type HarnessId,
} from "@root/types/DashboardConstants";
import type { OrderedHistoryEntry } from "@root/types/OutputHistoryTypes";
import {
  isPromptStep,
  isSubWorkflowStep,
  type PromptStep,
  type SubWorkflowOutput,
  type SubWorkflowStep,
} from "@root/types/CtrlYokeTypes";
import type { WorkflowStep } from "@store/workflowStore";
import {
  classifySubWorkflowWorktree,
  subWorkflowCreatesWorktree,
  toWorktreeObjectConfig,
} from "@root/utils/WorktreeConfigShape";

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

/**
 * The harness a step runs on, for every surface that colours or labels a step
 * by harness (the steps list, the chip rail and the output blocks), so a step
 * is painted the same on all three. A prompt step that has started reports the
 * harness its `_runtime` recorded; otherwise its own `harness` beats the
 * inherited one. An inline prompt child (a lane) runs with what its inner
 * prompt step would (D13). A script, a file-referenced child or an inline
 * script has no harness of its own.
 */
export function resolveEffectiveStepHarness(
  step: WorkflowStep,
  inheritedHarness: HarnessId | undefined
): HarnessId | undefined {
  if (isPromptStep(step)) {
    return (step._runtime?.harness ?? step.harness ?? inheritedHarness) as
      HarnessId | undefined;
  }
  const inlinePrompt = isSubWorkflowStep(step)
    ? getInlinePromptStep(step)
    : undefined;
  return inlinePrompt
    ? ((inlinePrompt.harness ?? inheritedHarness) as HarnessId | undefined)
    : undefined;
}

/** True when an inline definition declares its own worktree (a lane). */
export function hasInlineWorktree(step: SubWorkflowStep): boolean {
  return (
    typeof step.workflow !== "string" &&
    subWorkflowCreatesWorktree(
      classifySubWorkflowWorktree(step.workflow.worktree)
    )
  );
}

/**
 * The branch a lane's definition names, known before its child starts: only a
 * named worktree (`{ mode: named, branch }` or the string shorthand) names one;
 * a managed worktree's branch exists only once the child creates it. A branch
 * still holding a `{{var}}` placeholder is not shown, because the child
 * substitutes it and the authored text is not the branch it will use.
 */
export function getInlineWorktreeDefinedBranch(
  step: SubWorkflowStep
): string | undefined {
  if (typeof step.workflow === "string") return undefined;
  const config = toWorktreeObjectConfig(step.workflow.worktree);
  if (config === false || config.mode !== WORKTREE_MODES.NAMED) {
    return undefined;
  }
  const branch = config.branch.trim();
  return branch && !branch.includes("{{") ? branch : undefined;
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
