import * as assert from "assert";
import { suite, test } from "mocha";
import { mapWithConcurrency } from "../../utils/MapWithConcurrency";

suite("MapWithConcurrency", () => {
  test("preserves result order and respects the concurrency limit", async () => {
    let active = 0;
    let maximumActive = 0;
    const results = await mapWithConcurrency([0, 1, 2, 3], 2, async (item) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return item * 2;
    });

    assert.deepStrictEqual(results, [0, 2, 4, 6]);
    assert.strictEqual(maximumActive, 2);
  });
});
