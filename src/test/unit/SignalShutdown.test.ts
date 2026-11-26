import * as assert from "assert";
import { suite, test } from "mocha";
import {
  installTwoStageShutdown,
  type ShutdownSignal,
  type ShutdownTimers,
} from "../../cli/SignalShutdown";
import { PROCESS_SIGNALS } from "../../types/DashboardConstants";

suite("Two-stage signal shutdown", () => {
  test("starts graceful shutdown on SIGHUP", async () => {
    const listeners = new Map<ShutdownSignal, () => void>();
    const messages: string[] = [];
    let disposed = false;
    installTwoStageShutdown({
      signals: {
        once: (signal, listener) => listeners.set(signal, listener),
        off: (signal) => listeners.delete(signal),
      },
      signalNames: [PROCESS_SIGNALS.HANGUP],
      exit: () => undefined,
      timers: {
        setTimeout: () => 1 as unknown as ReturnType<typeof setTimeout>,
        clearTimeout: () => undefined,
      },
      isInteractive: false,
      countRunningWorkflows: () => 1,
      dispose: async () => { disposed = true; },
      deadlineMs: 5000,
      confirmationMessage: () => "confirm",
      shutdownMessage: () => "shutdown",
      forceMessage: "force",
      timeoutMessage: () => "timeout",
      onMessage: (message) => messages.push(message),
      exitCodeForSignal: () => 129,
      successExitCode: 0,
      timeoutExitCode: 1,
    });

    listeners.get(PROCESS_SIGNALS.HANGUP)?.();
    await Promise.resolve();
    await Promise.resolve();

    assert.strictEqual(disposed, true);
    assert.deepStrictEqual(messages, ["shutdown"]);
  });

  test("can leave successful exit to the run completion path", async () => {
    const listeners = new Map<ShutdownSignal, () => void>();
    const exits: number[] = [];
    const messages: string[] = [];
    const timers: ShutdownTimers = {
      setTimeout: () => 1 as unknown as ReturnType<typeof setTimeout>,
      clearTimeout: () => undefined,
    };
    let started = false;
    const triggerShutdown = installTwoStageShutdown({
      signals: {
        once: (signal, listener) => listeners.set(signal, listener),
        off: (signal) => listeners.delete(signal),
      },
      signalNames: [PROCESS_SIGNALS.INTERRUPT],
      exit: (code) => exits.push(code),
      timers,
      isInteractive: false,
      countRunningWorkflows: () => 1,
      dispose: async () => undefined,
      deadlineMs: 5000,
      confirmationMessage: () => "confirm",
      shutdownMessage: () => "shutdown",
      forceMessage: "force",
      timeoutMessage: () => "timeout",
      onMessage: (message) => messages.push(message),
      exitCodeForSignal: () => 5,
      successExitCode: 5,
      timeoutExitCode: 5,
      exitOnSuccess: false,
      onShutdownStarted: () => {
        started = true;
      },
    });

    triggerShutdown();
    await Promise.resolve();
    await Promise.resolve();

    assert.strictEqual(started, true);
    assert.deepStrictEqual(exits, []);
    assert.deepStrictEqual(messages, ["shutdown"]);
  });
});
