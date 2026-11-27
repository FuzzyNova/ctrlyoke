import { useMemo } from "react";
import { OUTPUT_HISTORY_KINDS } from "@root/types/DashboardConstants";
import type { SubWorkflowRanWith } from "@root/types/SubWorkflowTypes";
import { useUiStore } from "@store/uiStore";
import { useWorkflowStore } from "@store/workflowStore";
import {
  indexSubWorkflowRanWith,
  type SubWorkflowRanWithIndex,
} from "@utils/subWorkflowDisplay";

/**
 * What each settled child of the displayed run recorded it ran with, from the
 * `subWorkflowSettled` entries of the output the view shows (history or
 * live). The steps panel and the chip rail colour and label a lane from it
 * through `resolveEffectiveStepHarness`.
 *
 * The index keeps its identity until a settlement's ran-with data changes, so
 * streamed output, which replaces the entry array constantly, does not
 * invalidate every step row's harness callback.
 */
export function useSubWorkflowRanWithIndex(): SubWorkflowRanWithIndex {
  const isViewingHistory = useUiStore((state) => state.isViewingHistory);
  const entries = useWorkflowStore((state) =>
    isViewingHistory && state.historyOutputs
      ? state.historyOutputs.orderedEntries
      : state.liveOrderedEntries
  );
  const signature = useMemo(() => {
    const outputs = [];
    for (const entry of entries) {
      if (entry.kind === OUTPUT_HISTORY_KINDS.SUB_WORKFLOW) {
        outputs.push(entry.subWorkflowOutput);
      }
    }
    return JSON.stringify([...indexSubWorkflowRanWith(outputs)]);
  }, [entries]);
  return useMemo(
    () => new Map(JSON.parse(signature) as Array<[string, SubWorkflowRanWith]>),
    [signature]
  );
}
