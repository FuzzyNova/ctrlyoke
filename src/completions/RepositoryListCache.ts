const REPOSITORY_LIST_CACHE_DURATION_MS = 10_000;

interface RepositoryListCacheEntry<T> {
  items: T[];
  timestamp: number;
}

/**
 * Per-repository cache for completion lists read from Git. Each keystroke of
 * a dashboard completion field asks again, so a short TTL keeps typing from
 * spawning a Git process per character. A failed load caches an empty list.
 */
export class RepositoryListCache<T> {
  private readonly entries = new Map<string, RepositoryListCacheEntry<T>>();

  constructor(
    private readonly load: (repoRoot: string) => Promise<T[]>,
    private readonly durationMs = REPOSITORY_LIST_CACHE_DURATION_MS
  ) {}

  async get(repoRoot: string): Promise<T[]> {
    const now = Date.now();
    const cached = this.entries.get(repoRoot);
    if (cached && now - cached.timestamp < this.durationMs) {
      return cached.items;
    }
    let items: T[];
    try {
      items = await this.load(repoRoot);
    } catch {
      items = [];
    }
    this.entries.set(repoRoot, { items, timestamp: now });
    return items;
  }

  clear(): void {
    this.entries.clear();
  }
}
