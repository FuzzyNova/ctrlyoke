/**
 * Buffers streaming stdout chunks and releases them on a short interval.
 *
 * A spawned process emits one `data` event per stdout packet — `npm test` on a
 * mid-sized repo produces ~100 of them, and a chattier command far more. Each
 * one previously became its own dashboard message and its own timeline append.
 * That is wasteful on both ends, but it is specifically pathological for the
 * dashboard: script output renders as a single unbounded row, so every chunk
 * costs a full rebuild and re-layout of the whole accumulated text. Coalescing
 * bounds how often that work can be triggered, independent of how the process
 * happens to flush.
 *
 * Deliberately dependency-free (no `Log`, no config) so it stays usable from
 * every host — extension, CLI, MCP server. Errors thrown by `onFlush` are not
 * caught: an unhandled throw from the interval callback and one from the
 * original `stream.on("data")` callback are both uncaught exceptions, so
 * propagation semantics are unchanged.
 */

/** How long a chunk may sit buffered before it is released. */
export const STREAM_CHUNK_FLUSH_INTERVAL_MS = 100;
/**
 * Size at which the buffer is released immediately rather than waiting out the
 * interval, so a process that dumps megabytes at once still streams rather than
 * arriving in one payload.
 */
export const STREAM_CHUNK_FLUSH_MAX_CHARS = 32_768;

export interface StreamChunkCoalescerOptions {
  /** Test seam; production uses STREAM_CHUNK_FLUSH_INTERVAL_MS. */
  flushIntervalMs?: number;
  /** Test seam; production uses STREAM_CHUNK_FLUSH_MAX_CHARS. */
  maxBufferedChars?: number;
}

export class StreamChunkCoalescer {
  private buffer = "";
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly flushIntervalMs: number;
  private readonly maxBufferedChars: number;

  constructor(
    private readonly onFlush: (chunk: string) => void,
    options: StreamChunkCoalescerOptions = {}
  ) {
    this.flushIntervalMs =
      options.flushIntervalMs ?? STREAM_CHUNK_FLUSH_INTERVAL_MS;
    this.maxBufferedChars =
      options.maxBufferedChars ?? STREAM_CHUNK_FLUSH_MAX_CHARS;
  }

  /** Buffer a chunk, releasing it once the interval elapses or the cap is hit. */
  append(chunk: string): void {
    if (chunk.length === 0) {
      return;
    }
    this.buffer += chunk;

    if (this.buffer.length >= this.maxBufferedChars) {
      this.flush();
      return;
    }
    if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush();
      }, this.flushIntervalMs);
    }
  }

  /**
   * Release whatever is buffered now. Callers must invoke this before treating
   * the stream as finished — the buffered tail has to reach its consumer ahead
   * of any completion output that supersedes the streaming view.
   */
  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.buffer.length === 0) {
      return;
    }
    const pending = this.buffer;
    this.buffer = "";
    this.onFlush(pending);
  }

  /** True while a chunk is buffered and not yet released. */
  hasPending(): boolean {
    return this.buffer.length > 0;
  }
}
