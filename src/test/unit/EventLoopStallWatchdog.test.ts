import * as assert from "assert";
import { suite, test } from "mocha";
import {
  STALL_LIMIT_ENV_VAR,
  StallDetector,
  stallLimitFromEnv,
} from "../suite/eventLoopStallWatchdog";

suite("EventLoopStallWatchdog", () => {
  test("reports a stall only once the heartbeat has been still for the limit", () => {
    const detector = new StallDetector(30_000);

    assert.strictEqual(detector.observe(1, 0), undefined);
    assert.strictEqual(detector.observe(1, 29_999), undefined);
    assert.strictEqual(detector.observe(1, 30_000), 30_000);
  });

  test("a moving heartbeat resets the stall clock", () => {
    const detector = new StallDetector(30_000);

    detector.observe(1, 0);
    assert.strictEqual(detector.observe(2, 25_000), undefined);
    assert.strictEqual(detector.observe(2, 50_000), undefined);
    assert.strictEqual(detector.observe(2, 55_000), 30_000);
  });

  test("reads the stall limit from the environment, where 0 disables it", () => {
    assert.strictEqual(stallLimitFromEnv({}), 30_000);
    assert.strictEqual(
      stallLimitFromEnv({ [STALL_LIMIT_ENV_VAR]: " " }),
      30_000
    );
    assert.strictEqual(
      stallLimitFromEnv({ [STALL_LIMIT_ENV_VAR]: "5000" }),
      5_000
    );
    assert.strictEqual(
      stallLimitFromEnv({ [STALL_LIMIT_ENV_VAR]: "0" }),
      undefined
    );
    assert.strictEqual(
      stallLimitFromEnv({ [STALL_LIMIT_ENV_VAR]: "never" }),
      30_000,
      "an unparseable value must not silently disable the guard"
    );
  });
});
