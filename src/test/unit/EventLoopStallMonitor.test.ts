import * as assert from "assert";
import { afterEach, beforeEach, suite, test } from "mocha";
import { Log } from "../../utils/Log";
import { EventLoopStallMonitor } from "../../utils/EventLoopStallMonitor";

suite("EventLoopStallMonitor", () => {
  const originalDebug = Log.debug;
  let debugs: string[];

  beforeEach(() => {
    debugs = [];
    Log.debug = (message: string) => {
      debugs.push(message);
    };
  });

  afterEach(() => {
    Log.debug = originalDebug;
  });

  function monitor(clock: { value: number }): EventLoopStallMonitor {
    return new EventLoopStallMonitor({
      tickMs: 250,
      stallThresholdMs: 500,
      now: () => clock.value,
    });
  }

  test("stays silent while ticks arrive on time", () => {
    const clock = { value: 1000 };
    const subject = monitor(clock);
    for (let i = 0; i < 4; i++) {
      clock.value += 260;
      subject.tick();
    }
    assert.deepStrictEqual(debugs, []);
  });

  test("logs how late a tick was once it crosses the threshold", () => {
    const clock = { value: 1000 };
    const subject = monitor(clock);
    clock.value += 250 + 1800;
    subject.tick();
    assert.deepStrictEqual(debugs, [
      "[EventLoopStall] event loop blocked for ~1800ms",
    ]);
  });

  test("measures each tick from the previous one, not from start", () => {
    const clock = { value: 1000 };
    const subject = monitor(clock);
    clock.value += 250 + 900;
    subject.tick();
    clock.value += 250;
    subject.tick();
    assert.strictEqual(debugs.length, 1);
  });
});
