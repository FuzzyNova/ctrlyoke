import * as assert from "assert";
import { suite, test } from "mocha";
import {
  installTwoStageShutdown,
  type ShutdownSignal,
  type ShutdownTimers,
} from "../../cli/SignalShutdown";
import { PROCESS_SIGNALS } from "../../types/DashboardConstants";

suite("Two-stage signal shutdown", () => {
  test("can leave successful exit to the run completion path", async () => {
    const listeners = new Map<ShutdownSignal, () => void>();
    const exits: number[] = [];
    const messages: string[] = [];
    const timers: ShutdownTimers = {
      setTimeout: () => 1 as unknown as ReturnType<typeof setTimeout>,
      clearTimeout: () => undefined,
    };
    let started = false;
    installTwoStageShutdown({
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

    listeners.get(PROCESS_SIGNALS.INTERRUPT)?.();
    await Promise.resolve();
    await Promise.resolve();

    assert.strictEqual(started, true);
    assert.deepStrictEqual(exits, []);
    assert.deepStrictEqual(messages, ["shutdown"]);
  });
});
