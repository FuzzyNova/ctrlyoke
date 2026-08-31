/**
 * Pending output captures shared by completion construction and pick handling.
 * This belongs in `src/completions` because it bridges those two completion
 * lifecycle stages without depending on either editor implementation.
 */

export interface OutputCaptureRange {
  startLine: number;
  endLine: number;
}

export interface OutputCaptureEntry {
  text: string;
  channel: string;
  range?: OutputCaptureRange;
}

const MAX_ENTRIES = 200;
const TTL_MS = 5 * 60 * 1000;

interface CacheEntry extends OutputCaptureEntry {
  createdAt: number;
}

export class OutputCaptureCache {
  private readonly entries = new Map<string, CacheEntry>();

  set(id: string, entry: OutputCaptureEntry): void {
    this.evictExpired();
    this.entries.delete(id);
    this.entries.set(id, { ...entry, createdAt: Date.now() });

    while (this.entries.size > MAX_ENTRIES) {
      const oldestId = this.entries.keys().next().value;
      if (oldestId === undefined) {
        break;
      }
      this.entries.delete(oldestId);
    }
  }

  take(id: string): OutputCaptureEntry | undefined {
    this.evictExpired();
    const entry = this.entries.get(id);
    if (!entry) {
      return undefined;
    }
    this.entries.delete(id);
    const { createdAt: _createdAt, ...capture } = entry;
    return capture;
  }

  private evictExpired(): void {
    const cutoff = Date.now() - TTL_MS;
    for (const [id, entry] of this.entries) {
      if (entry.createdAt > cutoff) {
        continue;
      }
      this.entries.delete(id);
    }
  }
}

/** Singleton cache shared by completion builders and pick handlers. */
export const outputCaptureCache = new OutputCaptureCache();
