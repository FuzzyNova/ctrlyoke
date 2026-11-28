import {
  OUTPUT_HISTORY_KINDS,
  SUB_WORKFLOW_DASHBOARD_LABELS,
  WORKTREE_MERGE_OUTCOMES,
  isTerminalStepStatus,
  type HarnessId,
  type StepStatus,
} from "@root/types/DashboardConstants";
import type { OrderedHistoryEntry } from "@root/types/OutputHistoryTypes";
import {
  isPromptStep,
  isSubWorkflowStep,
  type PromptStep,
  type SubWorkflowOutput,
  type SubWorkflowStep,
} from "@root/types/CtrlYokeTypes";
import type { SubWorkflowRanWith } from "@root/types/SubWorkflowTypes";
import type { WorkflowStep } from "@store/workflowStore";
import {
  classifySubWorkflowWorktree,
  subWorkflowCreatesWorktree,
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

/** What each settled child ran with, keyed by its `childRunRef`. */
export type SubWorkflowRanWithIndex = ReadonlyMap<string, SubWorkflowRanWith>;

/**
 * Index the ran-with metadata of settled children by child run. A continued
 * child settles once per execution; the latest settlement wins.
 */
export function indexSubWorkflowRanWith(
  outputs: Iterable<SubWorkflowOutput>
): Map<string, SubWorkflowRanWith> {
  const index = new Map<string, SubWorkflowRanWith>();
  for (const output of outputs) {
    // A step that failed before a child run existed has nothing to index.
    if (output.childRunRef === undefined) continue;
    if (output.ranWith) index.set(output.childRunRef, output.ranWith);
    else index.delete(output.childRunRef);
  }
  return index;
}

/**
 * What an inline prompt child (a lane) recorded it ran with, once its
 * current child run has settled; `undefined` while it runs, for a file
 * child or an inline script, and for a settlement written before the field
 * existed.
 *
 * Only a step in a terminal status counts as settled. A child continued in
 * place (D6) keeps its `childRunRef`, so its earlier settlement stays in the
 * index while the continuation runs; that run may use other settings, so its
 * values are expected again until it settles once more. `status` is the
 * displayed status where the caller derives one (the steps list and the chip
 * rail), else the step's recorded status.
 */
export function getRecordedLaneRanWith(
  step: WorkflowStep,
  recorded: SubWorkflowRanWithIndex | undefined,
  status: StepStatus | undefined = step.status
): SubWorkflowRanWith | undefined {
  if (
    !recorded ||
    !isTerminalStepStatus(status) ||
    !isSubWorkflowStep(step) ||
    !getInlinePromptStep(step)
  ) {
    return undefined;
  }
  const childRunRef = step._runtime?.childRunRef;
  return childRunRef ? recorded.get(childRunRef) : undefined;
}

/**
 * The harness a step runs on, for every surface that colours or labels a step
 * by harness (the steps list, the chip rail and the output blocks), so a step
 * is painted the same on all three. A prompt step that has started reports the
 * harness its `_runtime` recorded; otherwise its own `harness` beats the
 * inherited one. An inline prompt child (a lane) reports the harness its
 * settled child recorded (`recorded`, read only once `status` is terminal;
 * see `getRecordedLaneRanWith`), else what its inner prompt step would
 * run with (D13). A script, a file-referenced child or an inline script has no
 * harness of its own.
 */
export function resolveEffectiveStepHarness(
  step: WorkflowStep,
  inheritedHarness: HarnessId | undefined,
  recorded?: SubWorkflowRanWithIndex,
  status?: StepStatus
): HarnessId | undefined {
  if (isPromptStep(step)) {
    return (step._runtime?.harness ?? step.harness ?? inheritedHarness) as
      HarnessId | undefined;
  }
  const inlinePrompt = isSubWorkflowStep(step)
    ? getInlinePromptStep(step)
    : undefined;
  if (!inlinePrompt) return undefined;
  return (
    getRecordedLaneRanWith(step, recorded, status ?? step.status)?.harness ??
    inlinePrompt.harness ??
    inheritedHarness
  );
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
  return typeof step.workflow === "string"
    ? undefined
    : classifySubWorkflowWorktree(step.workflow.worktree).namedBranch;
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
