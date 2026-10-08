import { useCallback, useMemo } from "react";
import { useWorkflowStore, type CliOutput } from "@store/workflowStore";
import { useUiStore } from "@store/uiStore";
import {
  OUTPUT_HISTORY_KINDS,
  FINAL_STEP_PHASES,
  isPromptExecutionPhase,
} from "../types/messages";

/**
 * Returns the final step's most recent CLI output from any pass.
 * History-aware, mirroring `useLatestStepOutput` below.
 *
 * Not restricted to the current pass: once a new pass begins, the queue
 * runs before the final step does, so the current pass has no output yet.
 * Matching only that pass blanked the footer's context-window bar and stats
 * from pass 2 onward. Context-window stats live only in output history, never
 * in `_runtime`, so there was nothing to fall back to. Queue steps likewise
 * keep their previous loop's output until the new loop's output arrives.
 *
 * Condition/setup phases are skipped for the same reason as `useLatestStepOutput`.
 *
 * Shared by WorkflowStepsPanel and PromptChipRail.
 */
export function useFinalStepLatestOutput(): CliOutput | null {
  const { liveOrderedEntries, historyOutputs } = useWorkflowStore();
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
        isPromptExecutionPhase(entry.phase) &&
        entry.target.kind === FINAL_STEP_PHASES.FINAL_STEP
      ) {
        return entry.cliOutput;
      }
    }
    return null;
  }, [entries]);
}

/**
 * Returns a `getLatestOutput(index)` helper that retrieves the most recent
 * CLI output entry for a queue step. History-aware: when the user is viewing
 * a historical run, entries are sourced from `historyOutputs` instead of
 * `liveOrderedEntries`.
 *
 * Only the step's own prompt/script phase counts. A step with a pre/end
 * condition emits *later* CLI entries at the same `stepIndex` for the condition
 * script, and those carry no tokens, no session ID, and the script's own
 * runtime — so taking the last entry regardless of phase silently replaced the
 * step row's context-window bar, token total, and duration with the condition
 * script's (a step whose `npm test` end condition ran for 2.3s reported "2.3s"
 * and no context bar, while its sibling steps without conditions were fine).
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
        !isPromptExecutionPhase(entry.phase) ||
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
