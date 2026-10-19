import { Log } from "./Log";

const DEFAULT_TICK_MS = 250;
const DEFAULT_STALL_THRESHOLD_MS = 500;

export interface EventLoopStallMonitorOptions {
  tickMs?: number;
  /** Lateness of one tick that earns a log line. */
  stallThresholdMs?: number;
  /** Injectable for tests; nothing in production passes it. */
  now?: () => number;
}

/**
 * Logs each time the extension host's event loop was blocked long enough to
 * delay a timer by `stallThresholdMs`. The router queue, hosted sockets and
 * forwarded browser logs all stop during such a stall, so the session log goes
 * silent; this line says how long, which separates "the host was busy" from
 * "something was awaiting".
 */
export class EventLoopStallMonitor {
  private readonly tickMs: number;
  private readonly stallThresholdMs: number;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastTickAt = 0;

  constructor(options: EventLoopStallMonitorOptions = {}) {
    this.tickMs = options.tickMs ?? DEFAULT_TICK_MS;
    this.stallThresholdMs =
      options.stallThresholdMs ?? DEFAULT_STALL_THRESHOLD_MS;
    this.now = options.now ?? (() => performance.now());
    this.lastTickAt = this.now();
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.lastTickAt = this.now();
    this.timer = setInterval(() => this.tick(), this.tickMs);
    // Diagnostics must never keep a host (or a test runner) alive.
    this.timer.unref?.();
  }

  dispose(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Record one timer tick. Public so tests can drive it without timers. */
  tick(): void {
    const at = this.now();
    const lateMs = Math.round(at - this.lastTickAt - this.tickMs);
    this.lastTickAt = at;
    if (lateMs >= this.stallThresholdMs) {
      Log.debug(`[EventLoopStall] event loop blocked for ~${lateMs}ms`);
    }
  }
}
