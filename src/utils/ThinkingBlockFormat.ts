import {
  CLI_EVENT_TYPES,
  OUTPUT_DEFAULT_LABELS,
} from "../types/DashboardConstants";
import type {
  CliEvent,
  TextData,
  ThinkingBlock,
} from "../types/CliOutputTypes";
import { formatTokenCount } from "./TokenFormatting";

/**
 * Whether `next` continues `previous` as one TEXT or THINKING block. The
 * streaming history buffer and the dashboard store both coalesce streamed
 * deltas with this rule, so persisted and live output group identically.
 */
export function canCoalesceTextEvents(
  previous: CliEvent | undefined,
  next: CliEvent
): previous is CliEvent {
  if (!previous || previous.type !== next.type) {
    return false;
  }
  if (next.type === CLI_EVENT_TYPES.TEXT) {
    return true;
  }
  return (
    next.type === CLI_EVENT_TYPES.THINKING &&
    canMergeThinkingBlocks(
      previous.data as ThinkingBlock,
      next.data as ThinkingBlock
    )
  );
}

/** Coalesce two events accepted by {@link canCoalesceTextEvents}. */
export function coalesceTextEvents(
  previous: CliEvent,
  next: CliEvent
): CliEvent {
  if (next.type === CLI_EVENT_TYPES.THINKING) {
    return {
      ...previous,
      data: mergeThinkingBlocks(
        previous.data as ThinkingBlock,
        next.data as ThinkingBlock
      ),
    };
  }
  const previousText = (previous.data as Partial<TextData>).text ?? "";
  const nextText = (next.data as Partial<TextData>).text ?? "";
  return {
    ...previous,
    data: { ...previous.data, text: previousText + nextText } as TextData,
  };
}

/**
 * Whether a thinking block has anything to show. A redacted block always
 * does: its label carries the reasoning metadata even when the provider
 * returned no summary text.
 */
export function isRenderableThinkingBlock(data: ThinkingBlock): boolean {
  return Boolean(data.text) || data.redacted === true;
}

/**
 * The header shown above a thinking block, e.g. `Reasoning summary · 2 parts
 * · 631 tokens` or `Reasoning · 453 tokens · encrypted`. Single-sourced so the
 * dashboard, terminal, export and row-height estimate all agree on it.
 */
export function formatThinkingLabel(data: ThinkingBlock): string {
  const base = data.label || OUTPUT_DEFAULT_LABELS.THINKING;
  const parts = [data.redacted && data.text ? `${base} summary` : base];
  if (data.segmentCount !== undefined && data.segmentCount > 1) {
    parts.push(`${data.segmentCount} parts`);
  }
  const tokens = formatTokenCount(data.reasoningTokens);
  if (tokens) {
    const approx = data.reasoningTokensEstimated ? "~" : "";
    const unit = data.reasoningTokens === 1 ? "token" : "tokens";
    parts.push(`${approx}${tokens} ${unit}`);
  }
  if (data.redacted && !data.text) {
    parts.push("encrypted");
  }
  return parts.join(" · ");
}

/**
 * Whether two consecutive thinking blocks belong in one rendered block.
 * Streamed deltas of the same label coalesce; a redacted block is only ever
 * combined with another redacted block.
 */
export function canMergeThinkingBlocks(
  previous: ThinkingBlock,
  next: ThinkingBlock
): boolean {
  return (
    (previous.label ?? undefined) === (next.label ?? undefined) &&
    Boolean(previous.redacted) === Boolean(next.redacted)
  );
}

/**
 * Combine two blocks accepted by {@link canMergeThinkingBlocks}. Plain blocks
 * are streamed deltas and concatenate as-is; redacted blocks are whole items
 * and combine as {@link combineThinkingItems}.
 */
export function mergeThinkingBlocks(
  previous: ThinkingBlock,
  next: ThinkingBlock
): ThinkingBlock {
  if (!previous.redacted) {
    return { ...previous, text: (previous.text ?? "") + (next.text ?? "") };
  }
  return combineThinkingItems(previous, next);
}

/**
 * Combine two complete reasoning items into one block: their texts become
 * separate paragraphs, and their token counts and segment counts add up.
 */
export function combineThinkingItems(
  previous: ThinkingBlock,
  next: ThinkingBlock
): ThinkingBlock {
  const tokens =
    previous.reasoningTokens === undefined && next.reasoningTokens === undefined
      ? undefined
      : (previous.reasoningTokens ?? 0) + (next.reasoningTokens ?? 0);
  const estimated =
    previous.reasoningTokensEstimated || next.reasoningTokensEstimated;
  return {
    ...previous,
    text: joinThinkingParagraphs([previous.text, next.text]),
    reasoningTokens: tokens,
    ...(estimated ? { reasoningTokensEstimated: true } : {}),
    segmentCount: (previous.segmentCount ?? 1) + (next.segmentCount ?? 1),
  };
}

/** Join whole-block thinking texts as markdown paragraphs, skipping blanks. */
export function joinThinkingParagraphs(
  texts: ReadonlyArray<string | undefined>
): string {
  return texts.filter((text): text is string => Boolean(text)).join("\n\n");
}
