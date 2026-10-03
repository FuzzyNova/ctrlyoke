import {
  FINAL_STEP_PHASES,
  HISTORY_EVENT_KINDS,
} from "../../types/DashboardConstants";
import type { OutputExecutionTarget } from "../../types/OutputHistoryTypes";
import type {
  HistorySearchDocument,
  HistorySearchResult,
} from "../../types/WorkflowTimelineTypes";
import {
  createHistorySearchMatcher,
  type HistorySearchMatch,
} from "./HistorySearchMatcher";
import { formatFinalPassLabel } from "../../utils/FinalStepLabels";

export const DEFAULT_HISTORY_SEARCH_SNIPPET_CHARS = 100;

export function projectHistorySearchResult(
  document: HistorySearchDocument,
  match: HistorySearchMatch,
  snippetChars?: number
): HistorySearchResult;
export function projectHistorySearchResult(
  document: HistorySearchDocument,
  query: string,
  snippetChars?: number
): HistorySearchResult;
export function projectHistorySearchResult(
  document: HistorySearchDocument,
  matchOrQuery: HistorySearchMatch | string,
  snippetChars: number = DEFAULT_HISTORY_SEARCH_SNIPPET_CHARS
): HistorySearchResult {
  const match = resolveHistorySearchMatch(document.text, matchOrQuery);
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
    matchSnippet: extractSnippet(document.text, match, snippetChars),
    matchContext: formatMatchContext(document.target),
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

/**
 * Extracts `snippetChars` of context around the first match, split 40:60
 * before:after the match. The matched query itself is additional context so
 * the existing default remains 40 characters before and 60 after it.
 */
export function extractSnippet(
  text: string,
  match: HistorySearchMatch | undefined,
  snippetChars?: number
): string;
export function extractSnippet(
  text: string,
  query: string,
  snippetChars?: number
): string;
export function extractSnippet(
  text: string,
  matchOrQuery: HistorySearchMatch | string | undefined,
  snippetChars: number = DEFAULT_HISTORY_SEARCH_SNIPPET_CHARS
): string {
  const normalizedSnippetChars = Math.max(0, Math.floor(snippetChars));
  const match = resolveHistorySearchMatch(text, matchOrQuery);
  if (match === undefined) {
    return text.slice(0, normalizedSnippetChars);
  }

  const beforeChars = Math.floor(normalizedSnippetChars * 0.4);
  const afterChars = normalizedSnippetChars - beforeChars;
  const start = Math.max(0, match.index - beforeChars);
  const end = Math.min(text.length, match.index + match.length + afterChars);
  const snippet = text.slice(start, end);
  return `${start > 0 ? "…" : ""}${snippet}${end < text.length ? "…" : ""}`;
}

function resolveHistorySearchMatch(
  text: string,
  matchOrQuery: HistorySearchMatch | string | undefined
): HistorySearchMatch | undefined {
  if (matchOrQuery === undefined || typeof matchOrQuery !== "string") {
    return matchOrQuery;
  }
  return createHistorySearchMatcher(matchOrQuery, false).find(text);
}

function formatMatchContext(target: OutputExecutionTarget): string {
  // Always the pass number: a retry is another attempt of the same pass, so
  // the attempt index must never stand in for it.
  if (target.kind === FINAL_STEP_PHASES.FINAL_STEP) {
    return formatFinalPassLabel(target.loopIndex + 1);
  }
  return `Prompt ${target.stepIndex + 1}`;
}
