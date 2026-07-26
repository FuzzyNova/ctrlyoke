import * as fs from "fs";
import { StringDecoder } from "string_decoder";
import {
  AntigravityTranscriptEntry,
  isAntigravityTranscriptEntry,
} from "./AntigravityTranscriptTypes";

interface TranscriptReadState {
  offset: number;
  pendingText: string;
  decoder: StringDecoder;
  prefix: string;
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

  async readEntries(
    transcriptPath: string
  ): Promise<AntigravityTranscriptEntry[]> {
    const records = await this.readRecords(transcriptPath);
    return records.map((record) => record.entry);
  }

  async readRecords(
    transcriptPath: string
  ): Promise<AntigravityTranscriptRecord[]> {
    let stats: fs.Stats;
    try {
      stats = await fs.promises.stat(transcriptPath);
    } catch {
      return [];
    }

    const identity = `${stats.dev}:${stats.ino}:${stats.birthtimeMs}`;
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
    if (state.prefix && stats.size >= state.prefix.length) {
      const currentPrefix = await this.readPrefix(
        transcriptPath,
        state.prefix.length
      );
      if (currentPrefix !== state.prefix) {
        state = this.createState();
        this.states.set(transcriptPath, state);
      }
    }
    state.identity = identity;

    if (stats.size === state.offset) {
      return [];
    }

    const length = stats.size - state.offset;
    const buffer = Buffer.alloc(length);
    try {
      const handle = await fs.promises.open(transcriptPath, "r");
      try {
        await handle.read(buffer, 0, length, state.offset);
      } finally {
        await handle.close();
      }
    } catch {
      return [];
    }

    state.offset = stats.size;
    const decoded = state.decoder.write(buffer);
    state.pendingText += decoded;
    if (!state.prefix) {
      state.prefix = state.pendingText.slice(0, 128);
    }

    const lines = state.pendingText.split(/\r?\n/);
    const hasTrailingNewline = /\r?\n$/.test(state.pendingText);
    if (hasTrailingNewline) {
      lines.pop();
      state.pendingText = "";
    } else {
      state.pendingText = lines.pop() ?? "";
    }

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

  reset(transcriptPath?: string): void {
    if (transcriptPath) {
      this.states.delete(transcriptPath);
    } else {
      this.states.clear();
    }
  }

  private createState(): TranscriptReadState {
    return {
      offset: 0,
      pendingText: "",
      decoder: new StringDecoder("utf8"),
      prefix: "",
      nextLineNumber: 0,
    };
  }

  private async readPrefix(
    transcriptPath: string,
    length: number
  ): Promise<string> {
    try {
      const handle = await fs.promises.open(transcriptPath, "r");
      try {
        const buffer = Buffer.alloc(length);
        const result = await handle.read(buffer, 0, length, 0);
        return buffer.subarray(0, result.bytesRead).toString("utf8");
      } finally {
        await handle.close();
      }
    } catch {
      return "";
    }
  }
}
