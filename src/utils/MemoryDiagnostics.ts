import { Log } from "./Log";

function toMb(bytes: number): number {
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
    `[MemoryDiagnostics] ${label}: rss=${toMb(usage.rss)}MB heapUsed=${toMb(usage.heapUsed)}MB heapTotal=${toMb(usage.heapTotal)}MB external=${toMb(usage.external)}MB arrayBuffers=${toMb(usage.arrayBuffers)}MB${extraSuffix}`
  );
}
