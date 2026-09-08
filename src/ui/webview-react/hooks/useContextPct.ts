import { useWorkflowStore } from "@store/workflowStore";
import { useUiStore } from "@store/uiStore";
import { calcContextPct } from "@utils/tokenUtils";
import type { OrderedCliHistoryEntry } from "@root/types/OutputHistoryTypes";
import {
  OUTPUT_HISTORY_KINDS,
  FINAL_STEP_PHASES,
  STEP_STATUS,
  isPromptExecutionPhase,
} from "../types/messages";
import { isWorkflowRunning } from "@utils/status";

/**
 * Returns a `getContextPct(stepIndex)` helper that looks up the context-window
 * usage percentage for a queued prompt step.
 *
 * Single source of truth shared by WorkflowStepsPanel and PromptChipRail.
 */
export function useContextPct() {
  const {
    steps,
    currentStep,
    executionState,
    liveOrderedEntries,
    historyOutputs,
    liveContextWindow,
  } = useWorkflowStore();
  const { isViewingHistory } = useUiStore();

  return function getContextPct(index: number): number | undefined {
    const stepStatus = steps[index]?.status;
    const isCurrentRunning =
      isWorkflowRunning(executionState) &&
      index === currentStep &&
      stepStatus !== STEP_STATUS.COMPLETED &&
      stepStatus !== STEP_STATUS.FAILED &&
      stepStatus !== STEP_STATUS.CANCELLED &&
      stepStatus !== STEP_STATUS.SKIPPED;

    if (isCurrentRunning) {
      const live = liveContextWindow?.[index];
      if (live?.size) {
        return calcContextPct(live.used, live.size);
      }
    }

    const entries =
      isViewingHistory && historyOutputs
        ? historyOutputs.orderedEntries
        : liveOrderedEntries;
    // Condition/setup scripts emit later CLI entries at this same stepIndex and
    // carry no tokens, so only the step's own prompt phase can answer this.
    const cliEntry = [...entries]
      .reverse()
      .find(
        (e) =>
          e.kind === OUTPUT_HISTORY_KINDS.CLI &&
          isPromptExecutionPhase((e as OrderedCliHistoryEntry).phase) &&
          "target" in e &&
          (e as any).target?.kind === FINAL_STEP_PHASES.QUEUE &&
          (e as any).target?.stepIndex === index
      );
    const tokens = cliEntry ? (cliEntry as any).cliOutput?.tokens : undefined;
    const completedPct = calcContextPct(
      tokens?.contextWindowUsed,
      tokens?.contextWindowSize
    );
    if (completedPct !== undefined) {
      return completedPct;
    }

    const runtime = steps[index]?._runtime;
    const runtimePct = calcContextPct(
      runtime?.contextWindowUsed,
      runtime?.contextWindowSize
    );
    if (runtimePct !== undefined) {
      return runtimePct;
    }

    const live = liveContextWindow?.[index];
    return live?.size ? calcContextPct(live.used, live.size) : undefined;
  };
}
