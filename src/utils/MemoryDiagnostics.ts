import { Log } from "./Log";

export function bytesToMb(bytes: number): number {
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}

/**
 * Logs the extension host's current `process.memoryUsage()` at a labeled
 * checkpoint. Call this around operations suspected of contributing to
 * extension-host heap growth (concurrent PTY sessions, search-index
 * rebuilds, the unindexed disk-scan fallback) so a future OOM crash dump can
 * be correlated against what ctrlyoke itself was holding onto at the time.
 */
export function logMemoryUsage(
  label: string,
  extra?: Record<string, string | number>
): void {
  const usage = process.memoryUsage();
  const extraSuffix = extra
    ? " " +
      Object.entries(extra)
        .map(([key, value]) => `${key}=${value}`)
        .join(" ")
    : "";
  Log.debug(
    `[MemoryDiagnostics] ${label}: rss=${bytesToMb(usage.rss)}MB heapUsed=${bytesToMb(usage.heapUsed)}MB heapTotal=${bytesToMb(usage.heapTotal)}MB external=${bytesToMb(usage.external)}MB arrayBuffers=${bytesToMb(usage.arrayBuffers)}MB${extraSuffix}`
  );
}

/** Live gauges a subsystem contributes to every memory sample. */
export type MemoryContextProvider = () => Record<string, string | number>;

const contextProviders = new Map<string, MemoryContextProvider>();
const MAX_RECENT_ACTIVITIES = 12;
const recentActivities: Array<{ at: number; label: string }> = [];

/**
 * Register gauges (e.g. hosted sockets' queued bytes) that the memory sampler
 * includes in each logged sample. Returns an unregister function.
 */
export function registerMemoryContext(
  name: string,
  provider: MemoryContextProvider
): () => void {
  contextProviders.set(name, provider);
  return () => {
    if (contextProviders.get(name) === provider) {
      contextProviders.delete(name);
    }
  };
}

/**
 * Record a potentially memory-heavy operation (a full run replay, a large
 * hosted send) so the next sample that sees heap growth can name what ran in
 * between. Cheap: a bounded in-memory ring, never logged on its own.
 */
export function noteMemoryActivity(label: string): void {
  recentActivities.push({ at: Date.now(), label });
  if (recentActivities.length > MAX_RECENT_ACTIVITIES) {
    recentActivities.shift();
  }
}

/** Activities noted at or after `since`, oldest first. */
export function getMemoryActivitiesSince(
  since: number
): ReadonlyArray<{ at: number; label: string }> {
  return recentActivities.filter((activity) => activity.at >= since);
}

/** Current values from every registered context provider, prefixed by name. */
export function collectMemoryContext(): Record<string, string | number> {
  const context: Record<string, string | number> = {};
  for (const [name, provider] of contextProviders) {
    try {
      for (const [key, value] of Object.entries(provider())) {
        context[`${name}.${key}`] = value;
      }
    } catch {
      // A failing gauge must never break sampling.
    }
  }
  return context;
}
