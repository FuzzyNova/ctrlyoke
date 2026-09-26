import * as assert from "assert";
import { setup, suite, test } from "mocha";
import * as vscode from "vscode";
import { LogLevel, SafeLogOutputChannel } from "../../utils/Log";

/**
 * Stand-in for the channel `vscode.window.createOutputChannel(name, { log: true })`
 * returns. It mirrors the one behaviour under test: VS Code's extension-host
 * wrapper (`createExtHostOutputChannel`/`createExtHostLogOutputChannel` in
 * `extHostOutput.ts`) throws `Channel has been closed` from every write once
 * disposed.
 *
 * A real channel is not used because it is wired up asynchronously with no
 * public "ready" signal, and disposing one before that finishes makes VS Code
 * log spurious "DisposableStore has already been disposed" errors. The only
 * way around that would be a fixed sleep.
 */
class FakeLogOutputChannel implements vscode.LogOutputChannel {
  readonly name = "ctrlyoke-log-test";
  readonly logLevel = vscode.LogLevel.Trace;
  readonly onDidChangeLogLevel = new vscode.EventEmitter<vscode.LogLevel>()
    .event;
  readonly lines: string[] = [];
  disposed = false;

  trace(message: string): void {
    this.record(message);
  }
  debug(message: string): void {
    this.record(message);
  }
  info(message: string): void {
    this.record(message);
  }
  warn(message: string): void {
    this.record(message);
  }
  error(message: string | Error): void {
    this.record(String(message));
  }
  append(value: string): void {
    this.record(value);
  }
  appendLine(value: string): void {
    this.record(value);
  }
  replace(value: string): void {
    this.record(value);
  }
  clear(): void {
    this.assertOpen();
  }
  show(): void {
    this.assertOpen();
  }
  hide(): void {
    this.assertOpen();
  }
  dispose(): void {
    this.disposed = true;
  }

  private record(line: string): void {
    this.assertOpen();
    this.lines.push(line);
  }

  private assertOpen(): void {
    if (this.disposed) {
      throw new Error("Channel has been closed");
    }
  }
}

const ALL_LEVELS = [
  LogLevel.TRACE,
  LogLevel.DEBUG,
  LogLevel.INFO,
  LogLevel.WARN,
  LogLevel.ERROR,
];

suite("SafeLogOutputChannel", () => {
  let channel: FakeLogOutputChannel;

  setup(() => {
    channel = new FakeLogOutputChannel();
  });

  test("writes reach the channel while it is open", () => {
    const safe = new SafeLogOutputChannel(channel);

    for (const level of ALL_LEVELS) {
      safe.write(level, `level ${level}`);
    }
    safe.appendLine("raw line");

    assert.deepStrictEqual(channel.lines, [
      ...ALL_LEVELS.map((level) => `level ${level}`),
      "raw line",
    ]);
    assert.strictEqual(safe.raw, channel);
  });

  test("writes after VS Code closes the channel are dropped, not thrown", () => {
    const safe = new SafeLogOutputChannel(channel);
    // What VS Code does to context.subscriptions during shutdown.
    channel.dispose();

    for (const level of ALL_LEVELS) {
      assert.doesNotThrow(() => safe.write(level, "after close"));
    }
    assert.doesNotThrow(() => safe.appendLine("after close"));
    assert.strictEqual(safe.raw, undefined);
    assert.doesNotThrow(() => safe.dispose());
  });

  test("dispose closes the channel and later writes are no-ops", () => {
    const safe = new SafeLogOutputChannel(channel);

    safe.dispose();

    assert.strictEqual(channel.disposed, true);
    assert.strictEqual(safe.raw, undefined);
    assert.doesNotThrow(() => safe.write(LogLevel.INFO, "after dispose"));
    assert.doesNotThrow(() => safe.dispose());
    assert.deepStrictEqual(channel.lines, []);
  });
});
