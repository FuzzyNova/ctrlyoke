import * as assert from "assert";
import { RetryableAsyncCache } from "../../utils/RetryableAsyncCache";

suite("RetryableAsyncCache", () => {
  test("shares successful probes and retries a failed probe", async () => {
    const cache = new RetryableAsyncCache<string>();
    let calls = 0;

    const result = await Promise.all([
      cache.getOrRun("test --version", async () => {
        calls += 1;
        return "1.0.0";
      }),
      cache.getOrRun("test --version", async () => {
        calls += 1;
        return "1.0.0";
      }),
    ]);

    assert.deepStrictEqual(result, ["1.0.0", "1.0.0"]);
    assert.strictEqual(calls, 1);

    await assert.rejects(
      cache.getOrRun("missing --version", async () => {
        calls += 1;
        throw new Error("not installed");
      }),
      /not installed/u
    );
    const retryResult = await cache.getOrRun("missing --version", async () => {
      calls += 1;
      return "1.0.0";
    });

    assert.strictEqual(retryResult, "1.0.0");
    assert.strictEqual(calls, 3);
  });
});
