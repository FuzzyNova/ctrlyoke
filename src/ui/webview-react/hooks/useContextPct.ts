import { useWorkflowStore } from "@store/workflowStore";
import { useUiStore } from "@store/uiStore";
import { calcContextPct } from "@utils/tokenUtils";
import { OUTPUT_HISTORY_KINDS, FINAL_PROMPT_PHASES } from "../types/messages";

/**
 * Returns a `getContextPct(stepIndex)` helper that looks up the context-window
 * usage percentage for a queued prompt step.
 *
 * Single source of truth shared by WorkflowStepsPanel and MobilePromptsSidebar.
 */
export function useContextPct() {
  const { liveOrderedEntries, historyOutputs } = useWorkflowStore();
  const { isViewingHistory } = useUiStore();

  return function getContextPct(index: number): number | undefined {
    const entries =
      isViewingHistory && historyOutputs
        ? historyOutputs.orderedEntries
        : liveOrderedEntries;
    const cliEntry = [...entries]
      .reverse()
      .find(
        (e) =>
          e.kind === OUTPUT_HISTORY_KINDS.CLI &&
          "target" in e &&
          (e as any).target?.kind === FINAL_PROMPT_PHASES.QUEUE &&
          (e as any).target?.stepIndex === index
      );
    if (!cliEntry) return undefined;
    const tokens = (cliEntry as any).cliOutput?.tokens;
    return calcContextPct(tokens?.contextWindowUsed, tokens?.contextWindowSize);
  };
}
