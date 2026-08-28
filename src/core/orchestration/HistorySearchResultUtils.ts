import {
  FINAL_STEP_PHASES,
  HISTORY_EVENT_KINDS,
} from "../../types/DashboardConstants";
import type { OutputExecutionTarget } from "../../types/OutputHistoryTypes";
import type {
  HistorySearchDocument,
  HistorySearchResult,
} from "../../types/WorkflowTimelineTypes";

export function projectHistorySearchResult(
  document: HistorySearchDocument,
  query: string
): HistorySearchResult {
  return {
    workflowKey: document.workflowKey,
    runRef: document.runRef,
    workflowName: document.workflowName,
    runId: document.runId,
    startedAt: document.startedAt,
    executionState: document.executionState,
    target: document.target,
    eventKind: document.eventKind,
    matchField: document.matchField,
    matchSnippet: extractSnippet(document.text, query),
    matchContext: formatMatchContext(document.target, document.attemptIndex),
    filePath: document.filePath,
  };
}

/**
 * Identifies the user-visible match represented by a search result.
 *
 * Streaming CLI history stores cumulative snapshots, so the same candidate
 * can be present in several timeline records with different sequences.
 * CLI sequence is deliberately excluded: those records all navigate to the
 * same output target and paint the same row in global search. Attempt is kept
 * so same-step reruns remain distinct. Status messages are individual events,
 * not cumulative snapshots, so their sequence remains part of the identity.
 */
export function getHistorySearchDocumentDedupeKey(
  document: HistorySearchDocument,
  result: HistorySearchResult
): string {
  return [
    result.workflowKey,
    result.runRef,
    result.runId,
    document.attemptIndex,
    result.eventKind === HISTORY_EVENT_KINDS.STATUS ? document.sequence : "",
    result.eventKind,
    result.matchField,
    result.matchContext,
    result.filePath ?? "",
    result.matchSnippet,
  ].join("::");
}

function extractSnippet(text: string, query: string): string {
  const searchText = text.toLowerCase();
  const searchQuery = query.toLowerCase();
  const index = searchText.indexOf(searchQuery);
  if (index === -1) {
    return text.slice(0, 100);
  }

  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, index + query.length + 60);
  const snippet = text.slice(start, end);
  return `${start > 0 ? "…" : ""}${snippet}${end < text.length ? "…" : ""}`;
}

function formatMatchContext(
  target: OutputExecutionTarget,
  attemptIndex: number
): string {
  if (target.kind === FINAL_STEP_PHASES.FINAL_STEP) {
    if (target.loopIndex > 0) {
      return `Final Step Loop ${target.loopIndex + 1}`;
    }
    if (attemptIndex > 0) {
      return `Final Step Loop ${attemptIndex}`;
    }
    return "Final Step";
  }
  return `Prompt ${target.stepIndex + 1}`;
}
