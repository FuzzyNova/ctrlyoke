import { ANTIGRAVITY_STREAM_JSON_EVENTS as STREAM_JSON_EVENTS } from "./AntigravityProtocolConstants";
import { splitCompleteLines } from "../../../utils/TextLines";

/**
 * Normalized usage fields emitted by Antigravity's stream-json protocol.
 * `thinking_tokens` is mapped to the shared reasoning-output concept here so
 * the provider does not need to know the wire-format spelling.
 */
export interface AntigravityStreamJsonUsage {
  inputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  cachedInputTokens?: number;
  totalTokens?: number;
}

export interface AntigravityStreamJsonUsageSnapshot {
  latestStepUsage?: AntigravityStreamJsonUsage;
  terminalUsage?: AntigravityStreamJsonUsage;
}

interface JsonRecord {
  [key: string]: unknown;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function parseUsage(value: unknown): AntigravityStreamJsonUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const usage: AntigravityStreamJsonUsage = {
    inputTokens: asFiniteNumber(value.input_tokens),
    outputTokens: asFiniteNumber(value.output_tokens),
    reasoningOutputTokens: asFiniteNumber(value.thinking_tokens),
    cachedInputTokens: asFiniteNumber(value.cache_read_tokens),
    totalTokens: asFiniteNumber(value.total_tokens),
  };
  return Object.values(usage).some((field) => field !== undefined)
    ? usage
    : undefined;
}

/** Parse one complete Antigravity stream-json NDJSON line. */
export function parseStreamJsonLine(line: string):
  | {
      conversationId?: string;
      usage?: AntigravityStreamJsonUsage;
      stepType?: string;
    }
  | undefined {
  if (!line.trim()) {
    return undefined;
  }

  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(event) || typeof event.event !== "string") {
    return undefined;
  }

  if (event.event === STREAM_JSON_EVENTS.INIT) {
    const conversationId =
      typeof event.conversation_id === "string" &&
      event.conversation_id.length > 0
        ? event.conversation_id
        : undefined;
    return conversationId ? { conversationId } : undefined;
  }

  if (event.event === STREAM_JSON_EVENTS.RESULT) {
    // agy nests the terminal payload under `result` — `{"event":"result",
    // "result":{"status":...,"usage":{...}}}` — verified against agy 1.1.8.
    // The top-level fallback only guards against wire-format drift.
    const result = isRecord(event.result) ? event.result : undefined;
    const usage = parseUsage(result?.usage) ?? parseUsage(event.usage);
    const conversationId =
      typeof result?.conversation_id === "string" &&
      result.conversation_id.length > 0
        ? result.conversation_id
        : undefined;
    if (!usage && !conversationId) {
      return undefined;
    }
    return { conversationId, usage };
  }

  if (event.event !== STREAM_JSON_EVENTS.STEP_UPDATE) {
    return undefined;
  }

  const stepUpdate = event.step_update;
  if (!isRecord(stepUpdate)) {
    return undefined;
  }

  const conversationId =
    typeof stepUpdate.conversation_id === "string" &&
    stepUpdate.conversation_id.length > 0
      ? stepUpdate.conversation_id
      : undefined;
  const stepType =
    typeof stepUpdate.step_type === "string" ? stepUpdate.step_type : undefined;
  const usage = parseUsage(stepUpdate.usage);
  if (!conversationId && !stepType && !usage) {
    return undefined;
  }
  return { conversationId, usage, stepType };
}

/**
 * Accumulates Antigravity's raw stdout without assuming that chunks align to
 * NDJSON lines. In particular, the terminal result line is commonly split.
 */
export class AntigravityStreamJsonUsageAccumulator {
  private incompleteLine = "";
  private latestStepUsage: AntigravityStreamJsonUsage | undefined;
  private terminalUsage: AntigravityStreamJsonUsage | undefined;

  ingest(chunk: string): void {
    this.incompleteLine += chunk;
    const { lines, remainder } = splitCompleteLines(this.incompleteLine);
    this.incompleteLine = remainder;

    for (const line of lines) {
      this.ingestLine(line);
    }
  }

  /** Parse a final unterminated line, if stdout ended without a newline. */
  flush(): void {
    if (this.incompleteLine) {
      this.ingestLine(this.incompleteLine);
      this.incompleteLine = "";
    }
  }

  getLatestStepUsage(): AntigravityStreamJsonUsage | undefined {
    return this.latestStepUsage;
  }

  getTerminalUsage(): AntigravityStreamJsonUsage | undefined {
    return this.terminalUsage;
  }

  getSnapshot(): AntigravityStreamJsonUsageSnapshot {
    const snapshot: AntigravityStreamJsonUsageSnapshot = {};
    if (this.latestStepUsage) {
      snapshot.latestStepUsage = this.latestStepUsage;
    }
    if (this.terminalUsage) {
      snapshot.terminalUsage = this.terminalUsage;
    }
    return snapshot;
  }

  reset(): void {
    this.incompleteLine = "";
    this.latestStepUsage = undefined;
    this.terminalUsage = undefined;
  }

  private ingestLine(line: string): void {
    const parsed = parseStreamJsonLine(line);
    if (!parsed?.usage) {
      return;
    }

    if (parsed.stepType) {
      this.latestStepUsage = parsed.usage;
    } else {
      this.terminalUsage = parsed.usage;
    }
  }
}
