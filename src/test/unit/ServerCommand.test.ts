import * as assert from "assert";
import { suite, test } from "mocha";
import {
  formatServerBanner,
  getUrlOpener,
  installServerShutdown,
  resolveServerSettings,
  type ServerSignalSource,
} from "../../cli/ServerCommand";
import type { ShutdownSignal, ShutdownTimers } from "../../cli/SignalShutdown";
import { handleCliError } from "../../cli/CliExitCode";
import { PROCESS_SIGNALS } from "../../types/DashboardConstants";

const settings = {
  autoStart: false,
  port: 4747,
  fallbackPorts: [4748],
  bindAddress: "127.0.0.1",
  theme: "dark" as const,
  tls: { enabled: false, certPath: "saved-cert", keyPath: "saved-key" },
  iconBgColor: "#000000",
  iconFgColor: "#ffffff",
};

class FakeSignals implements ServerSignalSource {
  private readonly handlers = new Map<ShutdownSignal, Set<() => void>>();

  once(signal: ShutdownSignal, listener: () => void): void {
    const listeners = this.handlers.get(signal) ?? new Set<() => void>();
    listeners.add(listener);
    this.handlers.set(signal, listeners);
  }

  off(signal: ShutdownSignal, listener: () => void): void {
    this.handlers.get(signal)?.delete(listener);
  }

  emit(signal: ShutdownSignal): void {
    const listeners = [...(this.handlers.get(signal) ?? [])];
    for (const listener of listeners) {
      this.handlers.get(signal)?.delete(listener);
      listener();
    }
  }
}

class FakeTimers implements ShutdownTimers {
  private now = 0;
  private nextId = 0;
  private readonly pending = new Map<
    number,
    { at: number; callback: () => void }
  >();

  setTimeout(
    callback: () => void,
    delayMs: number
  ): ReturnType<typeof setTimeout> {
    const id = ++this.nextId;
    this.pending.set(id, { at: this.now + delayMs, callback });
    return id as unknown as ReturnType<typeof setTimeout>;
  }

  clearTimeout(timer: ReturnType<typeof setTimeout>): void {
    this.pending.delete(timer as unknown as number);
  }

  advance(delayMs: number): void {
    this.now += delayMs;
    while (true) {
      const next = [...this.pending.entries()]
        .filter(([, timer]) => timer.at <= this.now)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (!next) return;
      this.pending.delete(next[0]);
      next[1].callback();
    }
  }
}

const flushPromises = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

suite("ServerCommand", () => {
  test("resolves command flags over server settings and keeps setting defaults", () => {
    const resolved = resolveServerSettings(
      {
        cwd: "workspace",
        port: "5010",
        bind: "0.0.0.0",
        https: true,
        theme: "light",
      },
      "C:/repo",
      settings
    );
    assert.strictEqual(resolved.cwd, require("path").resolve("workspace"));
    assert.strictEqual(resolved.port, 5010);
    assert.strictEqual(resolved.bindAddress, "0.0.0.0");
    assert.strictEqual(resolved.https, true);
    assert.strictEqual(resolved.theme, "light");
    assert.deepStrictEqual(resolved.fallbackPorts, [4748]);
    assert.strictEqual(
      resolveServerSettings({ strictPort: true }, "C:/repo", settings)
        .fallbackPorts.length,
      0
    );
  });

  test("leaves the theme to the live server.theme setting unless --theme is passed", () => {
    assert.strictEqual(
      resolveServerSettings({}, "C:/repo", settings).theme,
      undefined
    );
  });

  test("maps invalid server ports to a clean CLI usage error", () => {
    let error: unknown;
    assert.throws(
      () => resolveServerSettings({ port: "abc" }, "C:/repo", settings),
      (caught: unknown) => {
        error = caught;
        return true;
      }
    );

    const messages: string[] = [];
    const exitCodes: number[] = [];
    handleCliError(
      error,
      (message) => messages.push(message),
      (code) => exitCodes.push(code)
    );

    assert.deepStrictEqual(messages, [
      "Error: --port must be an integer between 0 and 65535.",
    ]);
    assert.deepStrictEqual(exitCodes, [2]);
  });

  test("prints the stop hint last in the banner", () => {
    const plain = formatServerBanner(
      "http://localhost:4747/?token=secret",
      [],
      false,
      "QR",
      false
    );
    assert.ok(plain.endsWith("Press Ctrl+C to stop the server."));
    assert.ok(plain.includes("http://localhost:4747/?token=secret"));
    assert.ok(!plain.includes("\u001b]8;"));
    const tty = formatServerBanner(
      "https://localhost:4747/?token=secret",
      ["192.168.1.4"],
      true,
      "QR",
      true
    );
    assert.ok(
      tty.includes("\u001b]8;;https://localhost:4747/?token=secret\u001b\\")
    );
    assert.ok(tty.includes("https://192.168.1.4:4747/?token=secret"));
    assert.ok(tty.includes("/cert"));
    assert.ok(tty.endsWith("Press Ctrl+C to stop the server."));
  });

  test("lists the public hostname URL ahead of the LAN URLs", () => {
    const banner = formatServerBanner(
      "https://localhost:4747/?token=secret",
      ["192.168.1.4"],
      false,
      "QR",
      true,
      "https://my-pc.example.ts.net:4747/?token=secret"
    );
    const lines = banner.split("\n");
    const publicLine = lines.indexOf(
      "Public: https://my-pc.example.ts.net:4747/?token=secret"
    );
    assert.ok(publicLine > 0);
    assert.ok(publicLine < lines.findIndex((line) => line.startsWith("LAN:")));
    assert.ok(
      !formatServerBanner("http://localhost:4747/", [], false, "QR", false)
        .split("\n")
        .some((line) => line.startsWith("Public:"))
    );
  });

  test("normalizes the public hostname setting and drops invalid values", () => {
    assert.strictEqual(
      resolveServerSettings({}, "C:/repo", {
        ...settings,
        publicHostname: " My-PC.Example.ts.net ",
      }).publicHostname,
      "my-pc.example.ts.net"
    );
    assert.strictEqual(
      resolveServerSettings({}, "C:/repo", {
        ...settings,
        publicHostname: "https://my-pc.example.ts.net",
      }).publicHostname,
      null
    );
    assert.strictEqual(
      resolveServerSettings({}, "C:/repo", settings).publicHostname,
      null
    );
  });

  test("selects the platform URL handler without shell interpolation", () => {
    const url = "https://localhost/?token=secret&theme=dark";
    assert.deepStrictEqual(getUrlOpener(url, "win32"), {
      command: "rundll32.exe",
      args: ["url.dll,FileProtocolHandler", url],
    });
    assert.deepStrictEqual(getUrlOpener(url, "darwin"), {
      command: "open",
      args: [url],
    });
    assert.deepStrictEqual(getUrlOpener(url, "linux"), {
      command: "xdg-open",
      args: [url],
    });
  });

  test("one Ctrl+C with no running workflows starts graceful shutdown", async () => {
    const signals = new FakeSignals();
    const timers = new FakeTimers();
    const exits: number[] = [];
    const messages: string[] = [];
    let disposeCount = 0;
    installServerShutdown(
      {
        dispose: () => {
          disposeCount += 1;
        },
      },
      {
        signals,
        timers,
        exit: (code) => exits.push(code),
        isInteractive: true,
        countRunningWorkflows: () => 0,
        onMessage: (message) => messages.push(message),
      }
    );

    signals.emit(PROCESS_SIGNALS.INTERRUPT);
    await flushPromises();
    assert.strictEqual(disposeCount, 1);
    assert.deepStrictEqual(exits, [0]);
    assert.deepStrictEqual(messages, [
      "Stopping 0 workflow(s) and shutting down… (press Ctrl+C again to force quit)",
    ]);
  });

  test("running workflows require a second Ctrl+C within the confirmation window", async () => {
    const signals = new FakeSignals();
    const timers = new FakeTimers();
    const messages: string[] = [];
    let disposeCount = 0;
    installServerShutdown(
      {
        dispose: () => {
          disposeCount += 1;
        },
      },
      {
        signals,
        timers,
        exit: () => undefined,
        isInteractive: true,
        countRunningWorkflows: () => 2,
        onMessage: (message) => messages.push(message),
      }
    );

    signals.emit(PROCESS_SIGNALS.INTERRUPT);
    assert.strictEqual(disposeCount, 0);
    assert.deepStrictEqual(messages, [
      "2 workflows are still running. Press Ctrl+C again within 3s to stop them and shut down the server.",
    ]);
    timers.advance(2999);
    signals.emit(PROCESS_SIGNALS.INTERRUPT);
    await flushPromises();
    assert.strictEqual(disposeCount, 1);
    assert.ok(messages[1].startsWith("Stopping 2 workflow(s)"));
  });

  test("confirmation expires and a later Ctrl+C warns again", () => {
    const signals = new FakeSignals();
    const timers = new FakeTimers();
    const messages: string[] = [];
    let disposeCount = 0;
    installServerShutdown(
      {
        dispose: () => {
          disposeCount += 1;
        },
      },
      {
        signals,
        timers,
        exit: () => undefined,
        isInteractive: true,
        countRunningWorkflows: () => 1,
        onMessage: (message) => messages.push(message),
      }
    );
    signals.emit(PROCESS_SIGNALS.INTERRUPT);
    timers.advance(3000);
    signals.emit(PROCESS_SIGNALS.INTERRUPT);
    assert.strictEqual(disposeCount, 0);
    assert.strictEqual(messages.length, 2);
    assert.ok(
      messages.every((message) =>
        message.includes("Press Ctrl+C again within 3s")
      )
    );
  });

  test("recounts workflows on the confirming press", async () => {
    const signals = new FakeSignals();
    const timers = new FakeTimers();
    const messages: string[] = [];
    const exits: number[] = [];
    let count = 1;
    let disposeCount = 0;
    installServerShutdown(
      {
        dispose: () => {
          disposeCount += 1;
        },
      },
      {
        signals,
        timers,
        exit: (code) => exits.push(code),
        isInteractive: true,
        countRunningWorkflows: () => count,
        onMessage: (message) => messages.push(message),
      }
    );
    signals.emit(PROCESS_SIGNALS.INTERRUPT);
    count = 0;
    signals.emit(PROCESS_SIGNALS.INTERRUPT);
    await flushPromises();
    assert.strictEqual(disposeCount, 1);
    assert.ok(messages[1].startsWith("Stopping 0 workflow(s)"));
    assert.deepStrictEqual(exits, [0]);
  });

  test("termination signals and non-interactive Ctrl+C skip the confirmation gate", async () => {
    for (const signal of [
      PROCESS_SIGNALS.TERMINATE,
      PROCESS_SIGNALS.HANGUP,
      PROCESS_SIGNALS.BREAK,
    ] as const) {
      const signals = new FakeSignals();
      const exits: number[] = [];
      let disposeCount = 0;
      installServerShutdown(
        {
          dispose: () => {
            disposeCount += 1;
          },
        },
        {
          signals,
          timers: new FakeTimers(),
          signalNames: [
            PROCESS_SIGNALS.INTERRUPT,
            PROCESS_SIGNALS.TERMINATE,
            PROCESS_SIGNALS.HANGUP,
            PROCESS_SIGNALS.BREAK,
          ],
          exit: (code) => exits.push(code),
          isInteractive: true,
          countRunningWorkflows: () => 1,
          onMessage: () => undefined,
        }
      );
      signals.emit(signal);
      await flushPromises();
      assert.strictEqual(
        disposeCount,
        1,
        `${signal} should dispose immediately`
      );
      assert.deepStrictEqual(exits, [0]);
    }

    const signals = new FakeSignals();
    let disposeCount = 0;
    installServerShutdown(
      {
        dispose: () => {
          disposeCount += 1;
        },
      },
      {
        signals,
        timers: new FakeTimers(),
        exit: () => undefined,
        isInteractive: false,
        countRunningWorkflows: () => 1,
        onMessage: () => undefined,
      }
    );
    signals.emit(PROCESS_SIGNALS.INTERRUPT);
    await flushPromises();
    assert.strictEqual(disposeCount, 1);
  });

  test("a signal during shutdown force exits with the signal's conventional code", async () => {
    const signals = new FakeSignals();
    const messages: string[] = [];
    const exits: number[] = [];
    installServerShutdown(
      { dispose: () => new Promise<void>(() => undefined) },
      {
        signals,
        timers: new FakeTimers(),
        exit: (code) => exits.push(code),
        isInteractive: true,
        countRunningWorkflows: () => 0,
        onMessage: (message) => messages.push(message),
      }
    );
    signals.emit(PROCESS_SIGNALS.INTERRUPT);
    await flushPromises();
    signals.emit(PROCESS_SIGNALS.INTERRUPT);
    assert.deepStrictEqual(exits, [130]);
    assert.strictEqual(messages.at(-1), "Force quitting.");

    const terminateSignals = new FakeSignals();
    const terminateExits: number[] = [];
    const terminateMessages: string[] = [];
    installServerShutdown(
      { dispose: () => new Promise<void>(() => undefined) },
      {
        signals: terminateSignals,
        timers: new FakeTimers(),
        exit: (code) => terminateExits.push(code),
        isInteractive: false,
        countRunningWorkflows: () => 0,
        onMessage: (message) => terminateMessages.push(message),
      }
    );
    terminateSignals.emit(PROCESS_SIGNALS.TERMINATE);
    await flushPromises();
    terminateSignals.emit(PROCESS_SIGNALS.TERMINATE);
    assert.deepStrictEqual(terminateExits, [143]);
    assert.strictEqual(terminateMessages.at(-1), "Force quitting.");
  });

  test("the overall deadline reports pending shutdown and exits non-zero", async () => {
    const signals = new FakeSignals();
    const timers = new FakeTimers();
    const messages: string[] = [];
    const exits: number[] = [];
    installServerShutdown(
      { dispose: () => new Promise<void>(() => undefined) },
      {
        signals,
        timers,
        exit: (code) => exits.push(code),
        isInteractive: false,
        countRunningWorkflows: () => 1,
        onMessage: (message) => messages.push(message),
      }
    );
    signals.emit(PROCESS_SIGNALS.TERMINATE);
    await flushPromises();
    timers.advance(5000);
    assert.deepStrictEqual(exits, [1]);
    assert.ok(messages.at(-1)?.includes("timed out"));
    assert.ok(messages.at(-1)?.includes("pending"));
  });
});
