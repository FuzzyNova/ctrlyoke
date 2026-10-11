import type { CliEvent, ThinkingBlock } from "../../../types/CliOutputTypes";
import {
  CLI_EVENT_TYPES,
  OUTPUT_DEFAULT_LABELS,
} from "../../../types/DashboardConstants";
import {
  combineThinkingItems,
  joinThinkingParagraphs,
} from "../../../utils/ThinkingBlockFormat";
import type { BaseCliEvent } from "../shared/interfaces/ILogParser";
import {
  CODEX_EVENT_TYPES,
  CODEX_PAYLOAD_TYPES,
} from "./CodexProtocolConstants";

interface CodexRawEvent extends BaseCliEvent {
  payload?: Record<string, any>;
}

/**
 * Event types that end a model response even when no usage record does.
 * Usage records precede all of these in current rollouts; this only keeps a
 * log without them from holding a response's events indefinitely.
 */
const RESPONSE_ITEM_BOUNDARIES: ReadonlySet<string> = new Set([
  CODEX_PAYLOAD_TYPES.FUNCTION_CALL_OUTPUT,
  CODEX_PAYLOAD_TYPES.CUSTOM_TOOL_CALL_OUTPUT,
]);
const EVENT_MSG_BOUNDARIES: ReadonlySet<string> = new Set([
  CODEX_PAYLOAD_TYPES.TASK_STARTED,
  CODEX_PAYLOAD_TYPES.TASK_COMPLETE,
  CODEX_PAYLOAD_TYPES.TURN_COMPLETED,
  CODEX_PAYLOAD_TYPES.USER_MESSAGE,
]);

/**
 * Build the THINKING block for a `response_item:reasoning` payload, or null
 * when it carries nothing. Raw `content` is shown when a model provides it;
 * otherwise the reasoning is encrypted and only its `summary` (populated when
 * `model_reasoning_summary` is on) is readable.
 */
export function buildCodexReasoningBlock(
  payload: Record<string, any>
): ThinkingBlock | null {
  const label = OUTPUT_DEFAULT_LABELS.REASONING;
  const content = readReasoningParts(payload.content);
  if (content) {
    return { text: content, label };
  }
  const summary = readReasoningParts(payload.summary);
  if (!summary && !payload.encrypted_content) {
    return null;
  }
  return { text: summary, label, redacted: true };
}

/** Reasoning parts are `{type, text}` arrays; older logs used a bare string. */
function readReasoningParts(parts: unknown): string {
  if (typeof parts === "string") {
    return parts;
  }
  if (!Array.isArray(parts)) {
    return "";
  }
  return joinThinkingParagraphs(
    parts.map((part) =>
      typeof part?.text === "string" ? (part.text as string) : undefined
    )
  );
}

/** Reasoning tokens reported for the response that just ended, if any. */
function readResponseReasoningTokens(raw: CodexRawEvent): number | undefined {
  const tokens =
    raw.type === CODEX_EVENT_TYPES.TOKEN_USAGE_RECORD
      ? raw.payload?.usage?.reasoning_output_tokens
      : raw.type === CODEX_EVENT_TYPES.EVENT_MSG &&
          raw.payload?.type === CODEX_PAYLOAD_TYPES.TOKEN_COUNT
        ? raw.payload?.info?.last_token_usage?.reasoning_output_tokens
        : undefined;
  return typeof tokens === "number" ? tokens : undefined;
}

function isResponseBoundary(raw: CodexRawEvent): boolean {
  const payloadType = raw.payload?.type as string | undefined;
  if (raw.type === CODEX_EVENT_TYPES.COMPACTED) {
    return true;
  }
  if (payloadType === undefined) {
    return false;
  }
  return (
    (raw.type === CODEX_EVENT_TYPES.RESPONSE_ITEM &&
      RESPONSE_ITEM_BOUNDARIES.has(payloadType)) ||
    (raw.type === CODEX_EVENT_TYPES.EVENT_MSG &&
      EVENT_MSG_BOUNDARIES.has(payloadType))
  );
}

/**
 * Fixed size of an encrypted reasoning item before any reasoning: measured on
 * gpt-6-luna rollouts, an item grows by roughly 14 characters per reasoning
 * token from about this base. Only used to split one response's token total
 * between reasoning blocks, which is labelled as an estimate.
 */
const ENCRYPTED_REASONING_BASE_CHARS = 1500;

/** Relative amount of reasoning in one raw reasoning item. */
function readReasoningWeight(raw: CodexRawEvent): number {
  const encrypted = raw.payload?.encrypted_content;
  const size =
    typeof encrypted === "string"
      ? encrypted.length - ENCRYPTED_REASONING_BASE_CHARS
      : readReasoningParts(raw.payload?.content).length;
  return Math.max(1, size);
}

function isReasoningEvent(event: CliEvent): boolean {
  return (
    event.type === CLI_EVENT_TYPES.THINKING &&
    (event.data as ThinkingBlock).label === OUTPUT_DEFAULT_LABELS.REASONING
  );
}

/**
 * Attaches each Codex model response's reasoning token count to its reasoning
 * block, and folds a response's consecutive reasoning items into one block.
 *
 * The count is only known once the response ends (`token_usage_record`, or
 * the later `token_count` when a log has no record), which is after the
 * response's message and tool call were written. So from the first reasoning
 * item until then, this holds every event the parser maps and releases them in
 * their original order with the count filled in. That delays the reasoning
 * row until the response ends; the rows after it, written moments before the
 * usage record, are barely delayed.
 *
 * Feed it every raw event with the CliEvents the parser mapped from it. The
 * batch parse uses a fresh instance; the streaming parse keeps one for the
 * session and calls {@link reset} at each turn start.
 */
export class CodexReasoningGrouper {
  private held: CliEvent[] = [];
  private reasoningEvents: CliEvent[] = [];
  /** Parallel to `reasoningEvents`: each block's share of the response. */
  private reasoningWeights: number[] = [];

  /** Returns the events now ready to emit, in order. */
  accept(raw: BaseCliEvent, mapped: readonly CliEvent[]): CliEvent[] {
    const codexEvent = raw as CodexRawEvent;
    const ready: CliEvent[] =
      this.isHolding() && isResponseBoundary(codexEvent) ? this.release() : [];

    for (const event of mapped) {
      if (isReasoningEvent(event)) {
        this.holdReasoning(event, readReasoningWeight(codexEvent));
      } else if (this.isHolding()) {
        this.held.push(event);
      } else {
        ready.push(event);
      }
    }

    const tokens = readResponseReasoningTokens(codexEvent);
    if (tokens !== undefined && this.isHolding()) {
      ready.push(...this.release(tokens));
    }
    return ready;
  }

  /** Release whatever is still held, without a count. */
  flush(): CliEvent[] {
    return this.release();
  }

  /** Drop held events; they belong to a turn that has already ended. */
  reset(): void {
    this.held = [];
    this.reasoningEvents = [];
    this.reasoningWeights = [];
  }

  private isHolding(): boolean {
    return this.reasoningEvents.length > 0;
  }

  private holdReasoning(event: CliEvent, weight: number): void {
    const last = this.held[this.held.length - 1];
    const lastIndex = this.reasoningEvents.length - 1;
    if (last !== undefined && last === this.reasoningEvents[lastIndex]) {
      const merged: CliEvent = {
        ...last,
        data: combineThinkingItems(
          last.data as ThinkingBlock,
          event.data as ThinkingBlock
        ),
      };
      this.held[this.held.length - 1] = merged;
      this.reasoningEvents[lastIndex] = merged;
      this.reasoningWeights[lastIndex] += weight;
      return;
    }
    this.held.push(event);
    this.reasoningEvents.push(event);
    this.reasoningWeights.push(weight);
  }

  private release(tokens?: number): CliEvent[] {
    if (tokens !== undefined) {
      this.assignTokens(tokens);
    }
    const released = this.held;
    this.reset();
    return released;
  }

  /**
   * A response's reasoning is normally one block and gets the exact count.
   * When the model wrote a message between reasoning items, the total is
   * split between the blocks by their size, rounded so the shares still sum
   * to the total, and marked as an estimate.
   */
  private assignTokens(tokens: number): void {
    const estimated = this.reasoningEvents.length > 1;
    const totalWeight = this.reasoningWeights.reduce((a, b) => a + b, 0);
    let cumulativeWeight = 0;
    let assigned = 0;
    this.reasoningEvents.forEach((event, index) => {
      cumulativeWeight += this.reasoningWeights[index];
      const share =
        Math.round((tokens * cumulativeWeight) / totalWeight) - assigned;
      assigned += share;
      const data = event.data as ThinkingBlock;
      data.reasoningTokens = share;
      if (estimated) {
        data.reasoningTokensEstimated = true;
      }
    });
  }
}
