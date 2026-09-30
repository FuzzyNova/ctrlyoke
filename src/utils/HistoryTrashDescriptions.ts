import {
  HISTORY_TRASH_ENTRY_KINDS,
  type HistoryTrashEntryKind,
} from "../types/DashboardConstants";
import type {
  HistoryTrashItem,
  HistoryTrashRestoreResult,
} from "../types/HistoryTrashTypes";

/*
 * Wording for Recently deleted entries, shared by the Undo toast, the
 * dashboard list, and `ctrlyoke history trash`. Webview-safe.
 */

export const TRASH_ENTRY_GONE_MESSAGE =
  "That item is no longer in Recently deleted.";

/** What a restore did, e.g. "Restored 3 runs". */
export function describeRestoreResult(
  result: HistoryTrashRestoreResult
): string {
  const restored =
    result.restoredLineages > 0
      ? `Restored ${result.restoredLineages} ${result.restoredLineages === 1 ? "workflow" : "workflows"}`
      : `Restored ${result.restoredRuns} ${result.restoredRuns === 1 ? "run" : "runs"}`;
  return result.conflicts.length > 0
    ? `${restored}. ${result.conflicts.length} could not go back because something else is there now; they stay in Recently deleted.`
    : restored;
}

/** A short description of what an entry holds, e.g. `Run 12 of "Fix bug"`. */
export function describeTrashEntry(entry: {
  kind: HistoryTrashEntryKind;
  items: readonly HistoryTrashItem[];
}): string {
  const lineages = entry.items.filter((item) => item.wholeLineage);
  const runCount = entry.items.reduce(
    (count, item) => count + item.runRefs.length,
    0
  );
  switch (entry.kind) {
    case HISTORY_TRASH_ENTRY_KINDS.RUN: {
      const item = entry.items[0];
      const runId = item?.runIds[0];
      return runId !== undefined
        ? `Run ${runId} of "${item.workflowName}"`
        : `A run of "${item?.workflowName ?? "a workflow"}"`;
    }
    case HISTORY_TRASH_ENTRY_KINDS.LINEAGE:
      return `"${entry.items[0]?.workflowName ?? "Workflow"}"`;
    case HISTORY_TRASH_ENTRY_KINDS.LINEAGE_RUNS:
      return `${runCount} ${runCount === 1 ? "run" : "runs"} of "${entry.items[0]?.workflowName ?? "a workflow"}"`;
    case HISTORY_TRASH_ENTRY_KINDS.ALL:
      return `${lineages.length.toLocaleString()} ${lineages.length === 1 ? "workflow" : "workflows"} (${runCount.toLocaleString()} ${runCount === 1 ? "run" : "runs"})`;
  }
}
