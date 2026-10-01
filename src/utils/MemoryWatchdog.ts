import * as path from "path";
import * as v8 from "v8";
import { Log } from "./Log";
import {
  bytesToMb,
  collectMemoryContext,
  getMemoryActivitiesSince,
} from "./MemoryDiagnostics";

const DEFAULT_SAMPLE_INTERVAL_MS = 15_000;
const DEFAULT_LOG_DELTA_BYTES = 50 * 1024 * 1024;

/**
 * Env var that opts into the heap snapshot: the heapUsed, in MB, at which one
 * snapshot is written. Unset means never, because a snapshot blocks the host
 * for seconds and a large run's view load alone can cross 1 GB.
 */
export const HEAP_SNAPSHOT_ENV_VAR = "CTRLYOKE_HEAP_SNAPSHOT_MB";

/** Snapshot threshold requested via {@link HEAP_SNAPSHOT_ENV_VAR}, if any. */
export function heapSnapshotThresholdFromEnv(
  env: NodeJS.ProcessEnv = process.env
): number | undefined {
  const mb = Number(env[HEAP_SNAPSHOT_ENV_VAR]);
  return Number.isFinite(mb) && mb > 0 ? mb * 1024 * 1024 : undefined;
}

export interface MemoryWatchdogOptions {
  /** Directory for the heap snapshot; snapshots are skipped while undefined. */
  getSnapshotDirectory: () => string | undefined;
  intervalMs?: number;
  /** Heap change since the last logged sample that earns a new log line. */
  logDeltaBytes?: number;
  /**
   * heapUsed at which the one-per-session heap snapshot is written; no
   * snapshot is ever written while undefined.
   */
  snapshotThresholdBytes?: number;
  /** Injectable for tests; nothing in production passes these. */
  memoryUsage?: () => NodeJS.MemoryUsage;
  writeHeapSnapshot?: (filePath: string) => string;
  now?: () => number;
}

function formatTime(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(11, 19);
}

/**
 * Samples extension-host memory on a timer so a heap OOM leaves a trajectory
 * in the session log instead of a log that just stops.
 *
 * A sample is logged only when heapUsed has moved by `logDeltaBytes` since the
 * last logged one, so a steady host costs one baseline line. Each logged line
 * carries the registered context gauges (`registerMemoryContext`) and the
 * activities noted since the previous line (`noteMemoryActivity`), which is
 * what ties a jump to the operation that caused it.
 *
 * When `snapshotThresholdBytes` is set, the first time heapUsed crosses it
 * one heap snapshot is written next to the session log.
 * `v8.writeHeapSnapshot` blocks the host and needs roughly the heap's size
 * again in memory, so pick a threshold well below the heap limit (a snapshot
 * attempted near it would itself OOM). It fires once per session, and only
 * while a session log file is being written (dev builds, or
 * `diagnostics.verboseLogging`).
 */
export class MemoryWatchdog {
  private readonly intervalMs: number;
  private readonly logDeltaBytes: number;
  private readonly snapshotThresholdBytes: number | undefined;
  private readonly memoryUsage: () => NodeJS.MemoryUsage;
  private readonly writeHeapSnapshot: (filePath: string) => string;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastLogged: { heapUsed: number; at: number } | undefined;
  private snapshotWritten = false;

  constructor(private readonly options: MemoryWatchdogOptions) {
    this.intervalMs = options.intervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS;
    this.logDeltaBytes = options.logDeltaBytes ?? DEFAULT_LOG_DELTA_BYTES;
    this.snapshotThresholdBytes = options.snapshotThresholdBytes;
    this.memoryUsage = options.memoryUsage ?? (() => process.memoryUsage());
    this.writeHeapSnapshot =
      options.writeHeapSnapshot ??
      ((filePath) => v8.writeHeapSnapshot(filePath));
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.sample();
    this.timer = setInterval(() => this.sample(), this.intervalMs);
    // Diagnostics must never keep a host (or a test runner) alive.
    this.timer.unref?.();
  }

  dispose(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Take one sample now. Public so tests can drive it without timers. */
  sample(): void {
    const usage = this.memoryUsage();
    const at = this.now();
    const previous = this.lastLogged;

    if (
      previous === undefined ||
      Math.abs(usage.heapUsed - previous.heapUsed) >= this.logDeltaBytes
    ) {
      this.logSample(usage, previous);
      this.lastLogged = { heapUsed: usage.heapUsed, at };
    }

    const threshold = this.snapshotThresholdBytes;
    if (
      threshold !== undefined &&
      !this.snapshotWritten &&
      usage.heapUsed >= threshold
    ) {
      this.trySnapshot(usage, at, threshold);
    }
  }

  private logSample(
    usage: NodeJS.MemoryUsage,
    previous: { heapUsed: number; at: number } | undefined
  ): void {
    const parts = [
      `heapUsed=${bytesToMb(usage.heapUsed)}MB`,
      previous
        ? `(${usage.heapUsed >= previous.heapUsed ? "+" : ""}${bytesToMb(usage.heapUsed - previous.heapUsed)}MB since ${formatTime(previous.at)})`
        : `(baseline, heapLimit=${bytesToMb(v8.getHeapStatistics().heap_size_limit)}MB)`,
      `heapTotal=${bytesToMb(usage.heapTotal)}MB`,
      `rss=${bytesToMb(usage.rss)}MB`,
      `external=${bytesToMb(usage.external)}MB`,
      `arrayBuffers=${bytesToMb(usage.arrayBuffers)}MB`,
      ...Object.entries(collectMemoryContext()).map(
        ([key, value]) => `${key}=${value}`
      ),
    ];
    const activities = previous
      ? getMemoryActivitiesSince(previous.at).map(
          (activity) => `${formatTime(activity.at)} ${activity.label}`
        )
      : [];
    Log.info(
      `[MemoryWatchdog] ${parts.join(" ")}` +
        (activities.length > 0 ? ` | activity: ${activities.join("; ")}` : "")
    );
  }

  private trySnapshot(
    usage: NodeJS.MemoryUsage,
    at: number,
    threshold: number
  ): void {
    const directory = this.options.getSnapshotDirectory();
    if (!directory) return;
    this.snapshotWritten = true;
    const filePath = path.join(
      directory,
      `ctrlyoke-heap-${new Date(at).toISOString().replace(/[:.]/g, "-")}.heapsnapshot`
    );
    Log.warn(
      `[MemoryWatchdog] heapUsed=${bytesToMb(usage.heapUsed)}MB crossed ${bytesToMb(threshold)}MB; writing heap snapshot (blocks the extension host): ${filePath}`
    );
    try {
      const written = this.writeHeapSnapshot(filePath);
      Log.warn(`[MemoryWatchdog] heap snapshot written: ${written}`);
    } catch (error) {
      Log.warn("[MemoryWatchdog] heap snapshot failed:", error);
    }
  }
}
