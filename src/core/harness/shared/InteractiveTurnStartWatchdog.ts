export interface TurnStartWatchdogClock {
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

const SYSTEM_CLOCK: TurnStartWatchdogClock = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer),
};

const WATCHDOG_STATE = {
  PENDING: "pending",
  STARTED: "started",
  EXPIRED: "expired",
  CANCELLED: "cancelled",
} as const;

type WatchdogState = (typeof WATCHDOG_STATE)[keyof typeof WATCHDOG_STATE];

/** Arbitrates hook/log/Stop signals for one interactive prompt submission. */
export class InteractiveTurnStartWatchdog {
  private timer?: ReturnType<typeof setTimeout>;
  private state: WatchdogState = WATCHDOG_STATE.PENDING;

  constructor(
    private readonly timeoutMs: number,
    private readonly clock: TurnStartWatchdogClock = SYSTEM_CLOCK
  ) {}

  start(onTimeout: () => void): void {
    if (this.state !== WATCHDOG_STATE.PENDING || this.timer !== undefined) return;
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined;
      if (this.state !== WATCHDOG_STATE.PENDING) return;
      this.state = WATCHDOG_STATE.EXPIRED;
      onTimeout();
    }, this.timeoutMs);
  }

  signal(): void {
    if (this.state !== WATCHDOG_STATE.PENDING) return;
    this.state = WATCHDOG_STATE.STARTED;
    this.clearTimer();
  }

  cancel(): void {
    if (this.state === WATCHDOG_STATE.PENDING) {
      this.state = WATCHDOG_STATE.CANCELLED;
    }
    this.clearTimer();
  }

  get didExpire(): boolean {
    return this.state === WATCHDOG_STATE.EXPIRED;
  }

  private clearTimer(): void {
    if (this.timer === undefined) return;
    this.clock.clearTimeout(this.timer);
    this.timer = undefined;
  }
}
