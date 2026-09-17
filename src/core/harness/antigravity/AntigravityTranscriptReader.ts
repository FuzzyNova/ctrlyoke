import * as fs from "fs";
import { StringDecoder } from "string_decoder";
import { PollingFsWatcher } from "../shared/FsWatcherHandles";
import {
  AntigravityTranscriptEntry,
  isAntigravityTranscriptEntry,
} from "./AntigravityTranscriptTypes";
import { splitCompleteLines } from "../../../utils/TextLines";

/** Bytes of the file head retained to detect a same-path rewrite. */
const PREFIX_BYTE_LENGTH = 128;

/**
 * Antigravity can append a human follow-up to the transcript without touching
 * the Go log that ctrlyoke originally discovered. Poll the authoritative
 * transcript cheaply so those appends still drive an incremental read.
 */
const TRANSCRIPT_CHANGE_POLL_INTERVAL_MS = 250;

interface TranscriptFileSnapshot {
  path: string;
  identity: string;
  size: number;
  modifiedAt: number;
}

interface TranscriptReadState {
  offset: number;
  pendingText: string;
  decoder: StringDecoder;
  /** Raw leading bytes, compared byte-for-byte so encoding cannot skew it. */
  prefix: Buffer;
  nextLineNumber: number;
  identity?: string;
}

export interface AntigravityTranscriptRecord {
  entry: AntigravityTranscriptEntry;
  eventId: string;
  lineNumber: number;
}

/**
 * Incremental append-only JSONL reader for one or more Antigravity transcripts.
 * State is keyed by the real transcript path, so parallel sessions cannot
 * share offsets or partial-line buffers.
 */
export class AntigravityTranscriptReader {
  private readonly states = new Map<string, TranscriptReadState>();
  private readonly inFlight = new Map<string, Promise<void>>();

  async readEntries(
    transcriptPath: string
  ): Promise<AntigravityTranscriptEntry[]> {
    const records = await this.readRecords(transcriptPath);
    return records.map((record) => record.entry);
  }

  /**
   * Watch whichever transcript path is currently authoritative. The resolver
   * is evaluated on every poll so a transcript created after monitor startup,
   * or a later promotion from the compact fallback to transcript_full.jsonl,
   * starts driving reads without reattaching the session watcher.
   */
  watchForChanges(
    resolveTranscriptPath: () => string | undefined,
    onChange: () => void
  ): fs.FSWatcher {
    let snapshot = this.readSnapshot(resolveTranscriptPath);
    const interval = setInterval(() => {
      const nextSnapshot = this.readSnapshot(resolveTranscriptPath);
      if (this.sameSnapshot(snapshot, nextSnapshot)) {
        return;
      }
      snapshot = nextSnapshot;
      onChange();
    }, TRANSCRIPT_CHANGE_POLL_INTERVAL_MS);
    return new PollingFsWatcher(interval);
  }

  /**
   * Reads are serialized per path. `AntigravityLogParser.readNewLines` is
   * driven concurrently by `CliLogMonitor` — the `fs.watch` callback, the
   * initial read, every catch-up read, and the drain loop all call it without
   * awaiting each other — while the read offset only advances after several
   * `await`s. Overlapping calls would therefore each read the same byte range
   * and re-emit the whole turn (with distinct line numbers, so nothing
   * downstream could dedupe it). Queuing here makes the later caller observe
   * the advanced offset and correctly return no new records.
   */
  async readRecords(
    transcriptPath: string
  ): Promise<AntigravityTranscriptRecord[]> {
    const previous = this.inFlight.get(transcriptPath) ?? Promise.resolve();
    const current = previous.then(() =>
      this.readRecordsExclusive(transcriptPath)
    );
    // The queued tail must never reject, or one failure would poison the chain.
    const tail = current.then(
      () => undefined,
      () => undefined
    );
    this.inFlight.set(transcriptPath, tail);
    try {
      return await current;
    } finally {
      if (this.inFlight.get(transcriptPath) === tail) {
        this.inFlight.delete(transcriptPath);
      }
    }
  }

  private async readRecordsExclusive(
    transcriptPath: string
  ): Promise<AntigravityTranscriptRecord[]> {
    let stats: fs.Stats;
    try {
      stats = await fs.promises.stat(transcriptPath);
    } catch {
      return [];
    }

    // dev+ino is the canonical file identity. `birthtimeMs` is deliberately
    // excluded: Node documents it as falling back to ctime on filesystems with
    // no creation time, and ctime changes on every append — which would drop
    // the state mid-session and re-emit the entire transcript.
    const identity = `${stats.dev}:${stats.ino}`;
    let state = this.states.get(transcriptPath);
    if (
      !state ||
      stats.size < state.offset ||
      (state.identity !== undefined && state.identity !== identity)
    ) {
      state = this.createState();
      this.states.set(transcriptPath, state);
    }

    // A rewrite can preserve size and, on some filesystems, the inode. The
    // append-only contract lets us detect that safely from the stable prefix.
    if (state.prefix.length > 0 && stats.size >= state.prefix.length) {
      const currentPrefix = await this.readPrefix(
        transcriptPath,
        state.prefix.length
      );
      // An unreadable head is transient (the file just stat'ed fine), so treat
      // it as unchanged rather than resetting and replaying everything.
      if (currentPrefix && !currentPrefix.equals(state.prefix)) {
        state = this.createState();
        this.states.set(transcriptPath, state);
      }
    }
    state.identity = identity;

    if (stats.size <= state.offset) {
      return [];
    }

    const readStart = state.offset;
    const length = stats.size - readStart;
    const buffer = Buffer.alloc(length);
    try {
      const handle = await fs.promises.open(transcriptPath, "r");
      try {
        await handle.read(buffer, 0, length, readStart);
      } finally {
        await handle.close();
      }
    } catch {
      return [];
    }

    state.offset = stats.size;
    // Grow the prefix until it spans PREFIX_BYTE_LENGTH bytes. While the file
    // is still shorter than that, `readStart` equals the prefix length, so this
    // buffer continues exactly where the recorded prefix stops.
    if (
      state.prefix.length < PREFIX_BYTE_LENGTH &&
      readStart === state.prefix.length
    ) {
      state.prefix = Buffer.concat([
        state.prefix,
        buffer.subarray(0, PREFIX_BYTE_LENGTH - state.prefix.length),
      ]);
    }

    state.pendingText += state.decoder.write(buffer);
    const { lines, remainder } = splitCompleteLines(state.pendingText);
    state.pendingText = remainder;

    const records: AntigravityTranscriptRecord[] = [];
    for (const rawLine of lines) {
      const lineNumber = state.nextLineNumber++;
      const line = rawLine.trim();
      if (!line) {
        continue;
      }
      try {
        const parsed: unknown = JSON.parse(line);
        if (isAntigravityTranscriptEntry(parsed)) {
          records.push({
            entry: parsed,
            eventId: `${transcriptPath}:${state.identity ?? "unknown"}:${lineNumber}`,
            lineNumber,
          });
        }
      } catch {
        // Ignore malformed complete lines; a partial final line is retained.
      }
    }
    return records;
  }

  private createState(): TranscriptReadState {
    return {
      offset: 0,
      pendingText: "",
      decoder: new StringDecoder("utf8"),
      prefix: Buffer.alloc(0),
      nextLineNumber: 0,
    };
  }

  private readSnapshot(
    resolveTranscriptPath: () => string | undefined
  ): TranscriptFileSnapshot | undefined {
    const transcriptPath = resolveTranscriptPath();
    if (!transcriptPath) {
      return undefined;
    }
    try {
      const stats = fs.statSync(transcriptPath);
      return {
        path: transcriptPath,
        identity: `${stats.dev}:${stats.ino}`,
        size: stats.size,
        modifiedAt: stats.mtimeMs,
      };
    } catch {
      return undefined;
    }
  }

  private sameSnapshot(
    previous: TranscriptFileSnapshot | undefined,
    current: TranscriptFileSnapshot | undefined
  ): boolean {
    if (!previous || !current) {
      return previous === current;
    }
    return (
      previous.path === current.path &&
      previous.identity === current.identity &&
      previous.size === current.size &&
      previous.modifiedAt === current.modifiedAt
    );
  }

  private async readPrefix(
    transcriptPath: string,
    length: number
  ): Promise<Buffer | undefined> {
    try {
      const handle = await fs.promises.open(transcriptPath, "r");
      try {
        const buffer = Buffer.alloc(length);
        const result = await handle.read(buffer, 0, length, 0);
        return buffer.subarray(0, result.bytesRead);
      } finally {
        await handle.close();
      }
    } catch {
      return undefined;
    }
  }
}
