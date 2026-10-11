import type { CliEvent, TextData } from "../../types/CliOutputTypes";
import {
  CLI_EVENT_TYPES,
  getExecutionPhaseKeySuffix,
  type ExecutionPhase,
} from "../../types/DashboardConstants";
import type { OutputExecutionTarget } from "../../types/OutputHistoryTypes";
import { FINAL_STEP_PHASES } from "../../types/DashboardConstants";
import {
  canCoalesceTextEvents,
  coalesceTextEvents,
} from "../../utils/ThinkingBlockFormat";

/**
 * Event types whose payload is nothing but streamed text, so consecutive ones
 * can be concatenated without losing information. Everything else (tool calls,
 * tool results, compaction, user steers) is a semantic boundary.
 */
const COALESCABLE_EVENT_TYPES = new Set<string>([
  CLI_EVENT_TYPES.TEXT,
  CLI_EVENT_TYPES.THINKING,
]);

/** Accumulated text that forces a write even mid-block, so a crash loses little. */
const DEFAULT_MAX_BUFFERED_CHARS = 4096;
/** Wall-clock ceiling on how long any delta may sit unwritten. */
const DEFAULT_MAX_BUFFERED_AGE_MS = 1000;

/** One coalesced write: at most one chunk delta plus one merged event batch. */
export interface StreamingHistoryFlush {
  target: OutputExecutionTarget;
  runIndex: number;
  attemptIndex: number;
  phase?: ExecutionPhase;
  /** Timestamp of the first delta in the batch, so ordering stays truthful. */
  timestampMs: number;
  /** Sequence assigned by TimelineRecorder for the flushed timeline event. */
  sequence?: number;
  chunk?: string;
  events?: CliEvent[];
}

export interface StreamingHistoryFlushResult {
  sequences: number[];
}

interface PendingEntry {
  historyFilePath: string;
  target: OutputExecutionTarget;
  runIndex: number;
  attemptIndex: number;
  phase?: ExecutionPhase;
  timestampMs: number;
  chunk: string;
  events: CliEvent[];
  bufferedChars: number;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export interface StreamingHistoryBufferOptions {
  maxBufferedChars?: number;
  maxBufferedAgeMs?: number;
}

/**
 * Coalesces live streaming deltas before they reach `events.jsonl`.
 *
 * Headless CLI execution and log tailing deliver output at wildly different
 * cadences. `CliLogEventPump` emits one batch per log line — a whole text block
 * or a single tool call. The headless path runs provider events through the
 * harness log parser, and every harness maps its token-level delta (Claude
 * `text_delta`, Copilot `assistant.message_delta`) into its own TEXT event.
 * Persisting those
 * one-for-one meant a file lock, manifest read, event append and manifest
 * rewrite *per token*.
 *
 * This buffer merges consecutive text-only events into a single event and
 * writes on a semantic boundary instead: a non-text event (tool call, result,
 * compaction), a size cap, or an age cap. The result is roughly one write per
 * content block or tool call, whichever transport produced it.
 *
 * Durability is bounded rather than immediate: a hard crash can lose at most
 * `maxBufferedAgeMs` of text, and never a tool event. Graceful paths
 * (`flush`) lose nothing.
 */
export class StreamingHistoryBuffer {
  private readonly pending = new Map<string, PendingEntry>();
  /**
   * Flushes already taken out of `pending` whose write or `onFlushed` publish
   * has not finished yet, keyed to their history file.
   */
  private readonly inFlight = new Map<Promise<void>, string>();
  private readonly maxBufferedChars: number;
  private readonly maxBufferedAgeMs: number;

  constructor(
    private readonly write: (
      historyFilePath: string,
      flush: StreamingHistoryFlush
    ) => Promise<StreamingHistoryFlushResult | void>,
    options: StreamingHistoryBufferOptions = {},
    private readonly onFlushed?: (
      flush: StreamingHistoryFlush,
      result: StreamingHistoryFlushResult
    ) => void
  ) {
    this.maxBufferedChars =
      options.maxBufferedChars ?? DEFAULT_MAX_BUFFERED_CHARS;
    this.maxBufferedAgeMs =
      options.maxBufferedAgeMs ?? DEFAULT_MAX_BUFFERED_AGE_MS;
  }

  /** Buffer a raw text delta, writing once a size or age cap is reached. */
  async addChunk(
    historyFilePath: string,
    target: OutputExecutionTarget,
    runIndex: number,
    attemptIndex: number,
    chunk: string,
    phase?: ExecutionPhase
  ): Promise<void> {
    const entry = this.ensureEntry(
      historyFilePath,
      target,
      runIndex,
      attemptIndex,
      phase
    );
    entry.chunk += chunk;
    entry.bufferedChars += chunk.length;

    if (entry.bufferedChars >= this.maxBufferedChars) {
      await this.flushEntry(
        this.getKey(historyFilePath, target, runIndex, attemptIndex, phase)
      );
    }
  }

  /**
   * Buffer parsed events. Consecutive text-only events merge into one; any
   * other event type is a boundary and writes the batch immediately.
   */
  async addEvents(
    historyFilePath: string,
    target: OutputExecutionTarget,
    runIndex: number,
    attemptIndex: number,
    events: CliEvent[],
    phase?: ExecutionPhase
  ): Promise<void> {
    if (events.length === 0) {
      return;
    }

    const key = this.getKey(
      historyFilePath,
      target,
      runIndex,
      attemptIndex,
      phase
    );
    const entry = this.ensureEntry(
      historyFilePath,
      target,
      runIndex,
      attemptIndex,
      phase
    );
    let hasBoundaryEvent = false;

    for (const event of events) {
      const previous = entry.events[entry.events.length - 1];
      if (canMerge(previous, event)) {
        entry.events[entry.events.length - 1] = coalesceTextEvents(
          previous,
          event
        );
      } else {
        entry.events.push(event);
        if (!COALESCABLE_EVENT_TYPES.has(event.type)) {
          hasBoundaryEvent = true;
        }
      }
      entry.bufferedChars += getEventTextLength(event);
    }

    if (hasBoundaryEvent || entry.bufferedChars >= this.maxBufferedChars) {
      await this.flushEntry(key);
    }
  }

  /**
   * Write everything buffered. Pass a history file to flush only that run's
   * entries; omit it to flush every run (process shutdown).
   *
   * Also waits for flushes already in flight (a boundary- or timer-triggered
   * write that started before this call), including their `onFlushed`
   * publish. Callers rely on "flush resolved" meaning every delta has reached
   * the live dashboard, so the completed output they send next can never
   * overtake the streamed tail it supersedes.
   */
  async flush(historyFilePath?: string): Promise<void> {
    const keys = [...this.pending.keys()].filter(
      (key) =>
        !historyFilePath ||
        this.pending.get(key)?.historyFilePath === historyFilePath
    );
    for (const key of keys) {
      await this.flushEntry(key);
    }
    const inFlight = [...this.inFlight]
      .filter(([, path]) => !historyFilePath || path === historyFilePath)
      .map(([promise]) => promise);
    // Another caller owns (and reports) any failure of these flushes.
    await Promise.allSettled(inFlight);
  }

  private ensureEntry(
    historyFilePath: string,
    target: OutputExecutionTarget,
    runIndex: number,
    attemptIndex: number,
    phase?: ExecutionPhase
  ): PendingEntry {
    const key = this.getKey(
      historyFilePath,
      target,
      runIndex,
      attemptIndex,
      phase
    );
    const existing = this.pending.get(key);
    if (existing) {
      return existing;
    }

    const entry: PendingEntry = {
      historyFilePath,
      target,
      runIndex,
      attemptIndex,
      phase,
      timestampMs: Date.now(),
      chunk: "",
      events: [],
      bufferedChars: 0,
      timer: undefined,
    };
    entry.timer = setTimeout(() => {
      void this.flushEntry(key);
    }, this.maxBufferedAgeMs);
    // Never hold the host process open just to flush a delta.
    entry.timer.unref?.();
    this.pending.set(key, entry);
    return entry;
  }

  private async flushEntry(key: string): Promise<void> {
    const entry = this.pending.get(key);
    if (!entry) {
      return;
    }

    this.pending.delete(key);
    if (entry.timer) {
      clearTimeout(entry.timer);
    }
    if (!entry.chunk && entry.events.length === 0) {
      return;
    }

    const inFlight = this.writeEntry(entry).finally(() => {
      this.inFlight.delete(inFlight);
    });
    this.inFlight.set(inFlight, entry.historyFilePath);
    await inFlight;
  }

  private async writeEntry(entry: PendingEntry): Promise<void> {
    const flush: StreamingHistoryFlush = {
      target: entry.target,
      runIndex: entry.runIndex,
      attemptIndex: entry.attemptIndex,
      phase: entry.phase,
      timestampMs: entry.timestampMs,
      chunk: entry.chunk || undefined,
      events: entry.events.length > 0 ? entry.events : undefined,
    };
    const result = await this.write(entry.historyFilePath, flush);
    if (result && result.sequences.length > 0) {
      flush.sequence = result.sequences[0];
      this.onFlushed?.(flush, result);
    }
  }

  private getKey(
    historyFilePath: string,
    target: OutputExecutionTarget,
    runIndex: number,
    attemptIndex: number,
    phase?: ExecutionPhase
  ): string {
    const base =
      target.kind === FINAL_STEP_PHASES.QUEUE
        ? `queue:${target.stepIndex}`
        : `final:${target.loopIndex}`;
    return `${historyFilePath}::${base}:run:${runIndex}:attempt:${attemptIndex}${getExecutionPhaseKeySuffix(phase)}`;
  }
}

/** Text-only events of the same type/label/caller concatenate losslessly. */
function canMerge(
  previous: CliEvent | undefined,
  next: CliEvent
): previous is CliEvent {
  return (
    canCoalesceTextEvents(previous, next) &&
    previous.callerType === next.callerType
  );
}

function getEventText(event: CliEvent): string {
  return (event.data as Partial<TextData>).text ?? "";
}

function getEventTextLength(event: CliEvent): number {
  return getEventText(event).length;
}
