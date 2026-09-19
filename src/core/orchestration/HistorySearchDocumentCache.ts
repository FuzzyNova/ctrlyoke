import type { HistorySearchDocument } from "../../types/WorkflowTimelineTypes";

/**
 * Approximate per-object V8 overhead for one cached document: the object's
 * own shape/hidden-class pointer, its numeric fields, and the map entry that
 * holds it. Combined with each string field's actual length (UTF-16, 2 bytes
 * per char), this tracks the cache's real held size rather than assuming a
 * single flat per-document constant — a document with a long `text`/`textLower`
 * costs more than one with a short one, exactly as it does on the real heap.
 */
const ESTIMATED_OBJECT_OVERHEAD_BYTES = 400;
const BYTES_PER_UTF16_CHAR = 2;

/** Estimated resident heap bytes for one cached document. */
export function estimateHistorySearchDocumentBytes(
  document: HistorySearchDocument
): number {
  let charCount = 0;
  for (const value of Object.values(document)) {
    if (typeof value === "string") {
      charCount += value.length;
    }
  }
  return charCount * BYTES_PER_UTF16_CHAR + ESTIMATED_OBJECT_OVERHEAD_BYTES;
}

function estimateDocumentsBytes(
  documents: readonly HistorySearchDocument[]
): number {
  let total = 0;
  for (const document of documents) {
    total += estimateHistorySearchDocumentBytes(document);
  }
  return total;
}

interface CacheEntry {
  documents: HistorySearchDocument[];
  startedAt: number;
  bytes: number;
}

/**
 * A bounded, per-workspace cache of parsed documents for the most recently
 * run workflows, consulted as the front of `HistorySearchIndexService`'s
 * existing recency-ordered scan. It is a prefix of that same scan, not a
 * second code path: a miss always falls back to the streamed disk scan the
 * service already had, so a miss can only be slow, never wrong (see
 * `dev/implemented/HISTORY_SEARCH_RESPONSIVE_QUERY_PLAN.md`, option B, and the
 * predecessor plan's option D — bounded residency was rejected there only
 * because it split correctness across two paths; this cache does not).
 *
 * Eviction is oldest-run-first (`startedAt` ascending), not LRU by access
 * time: the goal is to hold the most recent runs, not the most recently
 * queried ones, so a rare-term query that scans deep into old history must
 * not push a recent run out of the cache.
 */
export class HistorySearchDocumentCache {
  private readonly entries = new Map<string, CacheEntry>();
  private totalBytes = 0;
  private budgetBytes: number;

  constructor(budgetBytes: number) {
    this.budgetBytes = Math.max(0, budgetBytes);
  }

  /** Whether the cache is disabled (a zero or negative budget). */
  get disabled(): boolean {
    return this.budgetBytes <= 0;
  }

  /**
   * Updates the budget, evicting immediately if it shrank below the current
   * total. A budget of 0 drains the cache entirely on the next call, cleanly
   * disabling it — nothing else needs to check "is caching enabled" first.
   */
  setBudgetBytes(budgetBytes: number): void {
    this.budgetBytes = Math.max(0, budgetBytes);
    this.evictUntilWithinBudget();
  }

  get(shardName: string): HistorySearchDocument[] | undefined {
    return this.entries.get(shardName)?.documents;
  }

  /**
   * Whether a shard with this `startedAt` is worth fully parsing in order to
   * populate the cache. True while there is still budget headroom, or when
   * this run is more recent than the oldest run currently cached (in which
   * case it is worth evicting that one to make room). Checked *before* the
   * shard is read, so a scan visiting an old run that could never survive in
   * the cache never pays the cost of a full, unfiltered parse for nothing —
   * it stays on the existing prefiltered streaming path instead.
   */
  wouldRetain(startedAt: number): boolean {
    if (this.disabled) {
      return false;
    }
    if (this.totalBytes < this.budgetBytes) {
      return true;
    }
    const oldestStartedAt = this.getOldestStartedAt();
    return oldestStartedAt === undefined || startedAt > oldestStartedAt;
  }

  /**
   * Caches a shard's full, parsed document list. A shard whose own estimated
   * size exceeds the entire budget is not cached at all — evicting everything
   * else to make room for one oversized run would defeat the point of a
   * bounded cache of the *most-searched* part of the index.
   */
  set(
    shardName: string,
    startedAt: number,
    documents: HistorySearchDocument[]
  ): void {
    if (this.disabled) {
      return;
    }
    const bytes = estimateDocumentsBytes(documents);
    if (bytes > this.budgetBytes) {
      return;
    }
    this.remove(shardName);
    this.entries.set(shardName, { documents, startedAt, bytes });
    this.totalBytes += bytes;
    this.evictUntilWithinBudget();
  }

  /** Evicts one shard's cached documents, e.g. after an incremental rebuild rewrites or removes it. */
  invalidate(shardName: string): void {
    this.remove(shardName);
  }

  /** Drops every cached document, e.g. after a full rebuild regenerates every shard. */
  clear(): void {
    this.entries.clear();
    this.totalBytes = 0;
  }

  private remove(shardName: string): void {
    const existing = this.entries.get(shardName);
    if (existing) {
      this.entries.delete(shardName);
      this.totalBytes -= existing.bytes;
    }
  }

  private getOldestStartedAt(): number | undefined {
    let oldest: number | undefined;
    for (const entry of this.entries.values()) {
      if (oldest === undefined || entry.startedAt < oldest) {
        oldest = entry.startedAt;
      }
    }
    return oldest;
  }

  private evictUntilWithinBudget(): void {
    while (this.totalBytes > this.budgetBytes && this.entries.size > 0) {
      let oldestKey: string | undefined;
      let oldestStartedAt: number | undefined;
      for (const [shardName, entry] of this.entries) {
        if (
          oldestStartedAt === undefined ||
          entry.startedAt < oldestStartedAt
        ) {
          oldestStartedAt = entry.startedAt;
          oldestKey = shardName;
        }
      }
      if (oldestKey === undefined) {
        break;
      }
      this.remove(oldestKey);
    }
  }
}
