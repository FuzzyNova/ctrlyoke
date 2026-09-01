import { useCallback, useMemo } from "react";
import { useWorkflowStore, type CliOutput } from "@store/workflowStore";
import { useUiStore } from "@store/uiStore";
import { OUTPUT_HISTORY_KINDS, FINAL_STEP_PHASES } from "../types/messages";

/**
 * Returns the most recent CLI output for the final step's current loop
 * iteration. History-aware, mirroring `useLatestStepOutput` above.
 *
 * Shared by WorkflowStepsPanel and PromptChipRail.
 */
export function useFinalStepLatestOutput(): CliOutput | null {
  const { liveOrderedEntries, historyOutputs, finalStepLoopCount } =
    useWorkflowStore();
  const { isViewingHistory } = useUiStore();

  const entries =
    isViewingHistory && historyOutputs
      ? historyOutputs.orderedEntries
      : liveOrderedEntries;

  return useMemo(() => {
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (
        entry.kind === OUTPUT_HISTORY_KINDS.CLI &&
        entry.target.kind === FINAL_STEP_PHASES.FINAL_STEP &&
        entry.target.loopIndex === finalStepLoopCount
      ) {
        return entry.cliOutput;
      }
    }
    return null;
  }, [entries, finalStepLoopCount]);
}

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

  const entries =
    isViewingHistory && historyOutputs
      ? historyOutputs.orderedEntries
      : liveOrderedEntries;
  const latestOutputs = useMemo(() => {
    const result = new Map<number, CliOutput>();
    for (const entry of entries) {
      if (
        entry.kind !== OUTPUT_HISTORY_KINDS.CLI ||
        !("target" in entry) ||
        entry.target.kind !== FINAL_STEP_PHASES.QUEUE
      ) {
        continue;
      }
      result.set(entry.target.stepIndex, entry.cliOutput);
    }
    return result;
  }, [entries]);

  return useCallback(
    (index: number) => latestOutputs.get(index) ?? null,
    [latestOutputs]
  );
}
