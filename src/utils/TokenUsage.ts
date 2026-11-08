import { CLI_EVENT_TYPES } from "../types/DashboardConstants";
import type { CliEvent, CompactionData } from "../types/CliOutputTypes";
import type { CliOutput } from "../types/WebviewMessageTypes";
import type { AttemptTokenSnapshot } from "./TokenFormatting";

export interface CompactionSummary {
  /** Number of compaction events present in the completed parser output. */
  compactionCount: number;
  /** Sum of finite pre-compaction token counts, when any were reported. */
  compactedContextTokens?: number;
}

/**
 * Summarize compaction markers without deriving or estimating token totals.
 * Parsers own the event stream; this helper only preserves the context needed
 * to explain why a final context-window value may understate an attempt.
 */
export function summarizeCompactionEvents(
  events: readonly CliEvent[] | undefined
): CompactionSummary | undefined {
  if (!events) {
    return undefined;
  }

  let compactionCount = 0;
  let compactedContextTokens = 0;
  let hasKnownPreTokens = false;

  for (const event of events) {
    if (event.type !== CLI_EVENT_TYPES.COMPACTION) {
      continue;
    }

    compactionCount += 1;
    const preTokens = (event.data as CompactionData).preTokens;
    if (Number.isFinite(preTokens)) {
      compactedContextTokens += preTokens as number;
      hasKnownPreTokens = true;
    }
  }

  return {
    compactionCount,
    ...(hasKnownPreTokens ? { compactedContextTokens } : {}),
  };
}

/**
 * An attempt's token snapshot with `compactionCount` raised to the number of
 * compaction events streamed into its output so far. `tokens` is written only
 * when the attempt completes, so without this a running step (or one that
 * compacts again during post-completion follow-up activity) shows no
 * compaction even though the output pane already displays the marker.
 */
export function resolveDisplayedAttemptTokens(
  output: Pick<CliOutput, "tokens" | "structured"> | null | undefined
): AttemptTokenSnapshot | undefined {
  const tokens = output?.tokens;
  const streamedCount =
    summarizeCompactionEvents(output?.structured?.events)?.compactionCount ?? 0;
  if (streamedCount <= (tokens?.compactionCount ?? 0)) {
    return tokens;
  }
  return { ...tokens, compactionCount: streamedCount };
}
