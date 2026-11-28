import * as assert from "assert";
import { suite, test } from "mocha";
import { SubWorkflowControlRelay } from "../../core/orchestration/SubWorkflowControlRelay";
import type { SubWorkflowControl } from "../../types/SubWorkflowTypes";
import { captureLog } from "../helpers/logCapture";

class RecordingControl implements SubWorkflowControl {
  readonly calls: string[] = [];
  failWith?: Error;

  async pause(): Promise<void> {
    this.record("pause");
  }

  async cancelPause(): Promise<void> {
    this.record("cancelPause");
  }

  async stop(): Promise<void> {
    this.record("stop");
  }

  private record(action: string): void {
    this.calls.push(action);
    if (this.failWith) throw this.failWith;
  }
}

suite("SubWorkflowControlRelay", () => {
  test("replays only the stop when a pause and then a stop arrive before attach", async () => {
    const relay = new SubWorkflowControlRelay();
    await relay.pause();
    await relay.stop();
    const control = new RecordingControl();
    await relay.attach(control);
    assert.deepStrictEqual(control.calls, ["stop"]);
    assert.strictEqual(relay.wasStopRequested, true);
  });

  test("a stop clears a held pause, so a later cancelPause has nothing to cancel", async () => {
    const relay = new SubWorkflowControlRelay();
    await relay.pause();
    await relay.stop();
    await relay.cancelPause();
    const control = new RecordingControl();
    await relay.attach(control);
    assert.deepStrictEqual(control.calls, ["stop"]);
  });

  test("replays a held pause, and drops one cancelled before attach", async () => {
    const paused = new SubWorkflowControlRelay();
    await paused.pause();
    const pausedControl = new RecordingControl();
    await paused.attach(pausedControl);
    assert.deepStrictEqual(pausedControl.calls, ["pause"]);

    const cancelled = new SubWorkflowControlRelay();
    await cancelled.pause();
    await cancelled.cancelPause();
    const cancelledControl = new RecordingControl();
    await cancelled.attach(cancelledControl);
    assert.deepStrictEqual(cancelledControl.calls, []);
  });

  test("forwards directly once attached and logs a failed replay instead of throwing", async () => {
    const relay = new SubWorkflowControlRelay();
    await relay.stop();
    const control = new RecordingControl();
    control.failWith = new Error("child gone");
    const log = captureLog();
    try {
      await relay.attach(control);
    } finally {
      log.restore();
    }
    assert.ok(
      log.lines.some((line) => line.message.includes("Failed to forward stop")),
      JSON.stringify(log.lines)
    );

    // After a stop a pause is moot and is not forwarded.
    control.failWith = undefined;
    await relay.pause();
    assert.deepStrictEqual(control.calls, ["stop"]);

    const live = new SubWorkflowControlRelay();
    const liveControl = new RecordingControl();
    await live.attach(liveControl);
    await live.pause();
    await live.cancelPause();
    await live.stop();
    assert.deepStrictEqual(liveControl.calls, ["pause", "cancelPause", "stop"]);
  });
});
