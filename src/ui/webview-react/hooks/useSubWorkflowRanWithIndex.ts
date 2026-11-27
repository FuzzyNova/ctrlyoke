import { useMemo } from "react";
import { OUTPUT_HISTORY_KINDS } from "@root/types/DashboardConstants";
import type { OrderedHistoryEntry } from "@root/types/OutputHistoryTypes";
import type { SubWorkflowOutput } from "@root/types/CtrlYokeTypes";
import type { SubWorkflowRanWith } from "@root/types/SubWorkflowTypes";
import { useUiStore } from "@store/uiStore";
import { useWorkflowStore } from "@store/workflowStore";
import {
  indexSubWorkflowRanWith,
  type SubWorkflowRanWithIndex,
} from "@utils/subWorkflowDisplay";

const EMPTY_SIGNATURE = "";

/**
 * The ran-with index of an entry array, serialized. Cached per array: the
 * selector below runs on every store write, and the steps panel and the chip
 * rail both read the same array.
 */
const signatureByEntries = new WeakMap<
  readonly OrderedHistoryEntry[],
  string
>();

function subWorkflowRanWithSignature(
  entries: readonly OrderedHistoryEntry[]
): string {
  const cached = signatureByEntries.get(entries);
  if (cached !== undefined) return cached;
  const outputs: SubWorkflowOutput[] = [];
  for (const entry of entries) {
    if (entry.kind === OUTPUT_HISTORY_KINDS.SUB_WORKFLOW) {
      outputs.push(entry.subWorkflowOutput);
    }
  }
  const index = indexSubWorkflowRanWith(outputs);
  const signature =
    index.size === 0 ? EMPTY_SIGNATURE : JSON.stringify([...index]);
  signatureByEntries.set(entries, signature);
  return signature;
}

/**
 * What each settled child of the displayed run recorded it ran with, from the
 * `subWorkflowSettled` entries of the output the view shows (history or
 * live). The steps panel and the chip rail colour and label a lane from it
 * through `resolveEffectiveStepHarness`.
 *
 * The selector returns the serialized index, a primitive, so a streamed
 * output entry (which replaces the entry array) re-renders a subscriber only
 * when a settlement's ran-with data changes, and the index keeps its identity
 * until then. The index is derived rather than stored beside the entries
 * because the entry arrays have many writers (appends, CLI overlays,
 * snapshot applies, history promotion, clears), each of which would have to
 * keep a stored copy in step.
 */
export function useSubWorkflowRanWithIndex(): SubWorkflowRanWithIndex {
  const isViewingHistory = useUiStore((state) => state.isViewingHistory);
  const signature = useWorkflowStore((state) =>
    subWorkflowRanWithSignature(
      isViewingHistory && state.historyOutputs
        ? state.historyOutputs.orderedEntries
        : state.liveOrderedEntries
    )
  );
  return useMemo(
    () =>
      signature === EMPTY_SIGNATURE
        ? new Map<string, SubWorkflowRanWith>()
        : new Map(JSON.parse(signature) as Array<[string, SubWorkflowRanWith]>),
    [signature]
  );
}
