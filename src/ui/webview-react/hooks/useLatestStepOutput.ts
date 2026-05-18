import { useWorkflowStore } from "@store/workflowStore";
import { useUiStore } from "@store/uiStore";
import { OUTPUT_HISTORY_KINDS, FINAL_STEP_PHASES } from "../types/messages";

/**
 * Returns a `getLatestOutput(index)` helper that retrieves the most recent
 * CLI output entry for a queue step. History-aware: when the user is viewing
 * a historical run, entries are sourced from `historyOutputs` instead of
 * `liveOrderedEntries`.
 *
 * Shared by WorkflowStepsPanel and PromptChipRail.
 */
export function useLatestStepOutput() {
  const { liveOrderedEntries, historyOutputs } = useWorkflowStore();
  const { isViewingHistory } = useUiStore();

  return function getLatestOutput(index: number) {
    const entries =
      isViewingHistory && historyOutputs
        ? historyOutputs.orderedEntries
        : liveOrderedEntries;

    const cliEntries = entries.filter(
      (e) =>
        e.kind === OUTPUT_HISTORY_KINDS.CLI &&
        "target" in e &&
        (e as any).target.kind === FINAL_STEP_PHASES.QUEUE &&
        (e as any).target.stepIndex === index
    );
    if (cliEntries.length === 0) return null;
    return (cliEntries[cliEntries.length - 1] as any).cliOutput as any;
  };
}
