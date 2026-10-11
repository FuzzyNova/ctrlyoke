import { PROCESS_SIGNALS, type ProcessSignal } from "../types/DashboardConstants";

export type ShutdownSignal = Exclude<ProcessSignal, typeof PROCESS_SIGNALS.KILL>;

export interface ShutdownSignalSource {
  once(signal: ShutdownSignal, listener: () => void): unknown;
  off(signal: ShutdownSignal, listener: () => void): unknown;
}

export interface ShutdownTimers {
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

export interface TwoStageShutdownOptions {
  signals: ShutdownSignalSource;
  signalNames: readonly ShutdownSignal[];
  exit: (code: number) => void;
  timers: ShutdownTimers;
  isInteractive: boolean;
  countRunningWorkflows: () => number;
  dispose: () => void | Promise<void>;
  deadlineMs: number;
  confirmationMessage: (count: number) => string;
  shutdownMessage: (count: number) => string;
  forceMessage: string;
  timeoutMessage: () => string;
  onMessage: (message: string) => void;
  exitCodeForSignal: (signal: ShutdownSignal) => number;
  successExitCode: number;
  timeoutExitCode: number;
}

const DEFAULT_TIMERS: ShutdownTimers = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer),
};

export function installTwoStageShutdown(
  options: TwoStageShutdownOptions
): void {
  let shuttingDown = false;
  let exitRequested = false;
  let confirmationTimer: ReturnType<typeof setTimeout> | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let activeListeners: Array<() => void> = [];

  const removeListeners = (): void => {
    for (let index = 0; index < activeListeners.length; index += 1) {
      options.signals.off(options.signalNames[index], activeListeners[index]);
    }
    activeListeners = [];
  };

  const requestExit = (code: number): void => {
    if (exitRequested) return;
    exitRequested = true;
    removeListeners();
    if (confirmationTimer !== undefined) {
      options.timers.clearTimeout(confirmationTimer);
      confirmationTimer = undefined;
    }
    if (deadlineTimer !== undefined) {
      options.timers.clearTimeout(deadlineTimer);
      deadlineTimer = undefined;
    }
    options.exit(code);
  };

  const armListeners = (): void => {
    activeListeners = options.signalNames.map((signal) => {
      const listener = (): void => handleSignal(signal);
      options.signals.once(signal, listener);
      return listener;
    });
  };

  const beginShutdown = (): void => {
    shuttingDown = true;
    if (confirmationTimer !== undefined) {
      options.timers.clearTimeout(confirmationTimer);
      confirmationTimer = undefined;
    }
    const count = options.countRunningWorkflows();
    options.onMessage(options.shutdownMessage(count));
    armListeners();
    deadlineTimer = options.timers.setTimeout(() => {
      if (!exitRequested) {
        options.onMessage(options.timeoutMessage());
        requestExit(options.timeoutExitCode);
      }
    }, options.deadlineMs);

    void Promise.resolve()
      .then(() => options.dispose())
      .then(() => {
        requestExit(options.successExitCode);
      })
      .catch((error: unknown) => {
        options.onMessage(
          `Shutdown failed: ${error instanceof Error ? error.message : String(error)}`
        );
        requestExit(options.timeoutExitCode);
      });
  };

  function handleSignal(signal: ShutdownSignal): void {
    removeListeners();
    if (shuttingDown) {
      options.onMessage(options.forceMessage);
      requestExit(options.exitCodeForSignal(signal));
      return;
    }

    const count = options.countRunningWorkflows();
    if (signal === PROCESS_SIGNALS.INTERRUPT && options.isInteractive && count > 0) {
      const withinConfirmation = confirmationTimer !== undefined;
      if (confirmationTimer !== undefined) {
        options.timers.clearTimeout(confirmationTimer);
        confirmationTimer = undefined;
      }
      if (!withinConfirmation) {
        options.onMessage(options.confirmationMessage(count));
        confirmationTimer = options.timers.setTimeout(() => {
          confirmationTimer = undefined;
        }, 3000);
        armListeners();
        return;
      }
    }
    beginShutdown();
  }

  armListeners();
}

export { DEFAULT_TIMERS as defaultShutdownTimers };
