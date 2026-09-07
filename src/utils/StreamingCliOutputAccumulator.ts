import type { CliEvent } from "../types/CliOutputTypes";
import type { CliOutput } from "../types/WebviewMessageTypes";
import { normalizeCliEvents } from "./CliEventNormalizer";

interface PendingStreamingDeltas {
  chunks: string[];
  events: CliEvent[];
}

/**
 * Buffers a run's streamed CLI deltas per attempt and folds them into that
 * attempt's `CliOutput` exactly once.
 *
 * Replaying a persisted run means walking every `cliOutputChunkAppended` /
 * `cliOutputEventsAppended` event it ever wrote. Applying each delta eagerly —
 * `normalizeCliEvents([...alreadyNormalized, ...batch])` per batch — re-clones
 * and re-pairs the whole accumulated array once per batch, which is quadratic
 * in the number of batches. On a real large run (721 batches growing to ~1150
 * events for a single step) that alone cost ~5s of extension-host CPU per
 * history load; deferring to one normalize pass per attempt made it ~0.
 *
 * Accumulating raw and normalizing once is also the more faithful projection:
 * it is exactly what the harness would have produced had the attempt been
 * recorded as a single aggregate instead of streamed.
 *
 * Callers must `discard(key)` whenever a fresh aggregate replaces the attempt's
 * output, since a replacement supersedes every delta buffered before it.
 */
export class StreamingCliOutputAccumulator {
  private readonly pending = new Map<string, PendingStreamingDeltas>();

  appendChunk(key: string, chunk: string): void {
    this.ensure(key).chunks.push(chunk);
  }

  appendEvents(key: string, events: readonly CliEvent[]): void {
    this.ensure(key).events.push(...events);
  }

  /** Drops everything buffered for `key`; the next append starts a new batch. */
  discard(key: string): void {
    this.pending.delete(key);
  }

  keys(): Iterable<string> {
    return this.pending.keys();
  }

  /**
   * Returns `output` with every delta buffered for `key` applied, or the
   * unchanged `output` when nothing is buffered. Consumes the buffer.
   */
  flush(key: string, output: CliOutput): CliOutput {
    const deltas = this.pending.get(key);
    if (!deltas) {
      return output;
    }
    this.pending.delete(key);

    let result = output;
    if (deltas.chunks.length > 0) {
      result = {
        ...result,
        response: result.response + deltas.chunks.join(""),
      };
    }
    if (deltas.events.length > 0) {
      result = {
        ...result,
        structured: {
          ...result.structured,
          events: normalizeCliEvents([
            ...(result.structured?.events ?? []),
            ...deltas.events,
          ]),
          metadata: result.structured?.metadata ?? {},
        },
      };
    }
    return result;
  }

  private ensure(key: string): PendingStreamingDeltas {
    let deltas = this.pending.get(key);
    if (!deltas) {
      deltas = { chunks: [], events: [] };
      this.pending.set(key, deltas);
    }
    return deltas;
  }
}
