/**
 * TtlCache — a simple TTL-based cache for async discovery results.
 *
 * Avoids re-scanning the filesystem on every call by caching results
 * for a configurable number of milliseconds.
 *
 * Usage:
 *   const cache = new TtlCache<AgentInfo>(5000);
 *   const agents = await cache.get(() => AgentDiscovery.discoverAgents(root));
 */
export class TtlCache<T> {
  private cached: T[] = [];
  private timestamp = 0;

  constructor(private readonly ttlMs: number) {}

  /**
   * Return cached items if still fresh; otherwise call `fn` to refresh the cache.
   */
  async get(fn: () => Promise<T[]>): Promise<T[]> {
    const now = Date.now();
    if (this.cached.length > 0 && now - this.timestamp < this.ttlMs) {
      return this.cached;
    }
    this.cached = await fn();
    this.timestamp = now;
    return this.cached;
  }

  /** Invalidate the cache, forcing a refresh on the next call. */
  invalidate(): void {
    this.cached = [];
    this.timestamp = 0;
  }
}
