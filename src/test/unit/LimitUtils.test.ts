import * as assert from "assert";
import { suite, test } from "mocha";
import { UNLIMITED_LIMIT } from "../../types/DashboardConstants";
import {
  exceedsLimit,
  formatRetryDenominator,
  isUnlimited,
} from "../../utils/LimitUtils";
import {
  getEffectiveMaxStepsSource,
  resolveEffectiveMaxSteps,
} from "../../utils/QueueLimitUtils";

suite("LimitUtils", () => {
  test("recognizes only the shared unlimited sentinel", () => {
    assert.strictEqual(isUnlimited(UNLIMITED_LIMIT), true);
    assert.strictEqual(isUnlimited(0), false);
    assert.strictEqual(isUnlimited(10), false);
  });

  test("formats finite and unlimited retry denominators", () => {
    assert.strictEqual(formatRetryDenominator(3), "3");
    assert.strictEqual(formatRetryDenominator(UNLIMITED_LIMIT), "∞");
  });

  test("exceeds a finite limit only when the count is greater", () => {
    assert.strictEqual(exceedsLimit(9, 10), false);
    assert.strictEqual(exceedsLimit(10, 10), false);
    assert.strictEqual(exceedsLimit(11, 10), true);
    assert.strictEqual(exceedsLimit(100, UNLIMITED_LIMIT), false);
  });
});

suite("resolveEffectiveMaxSteps", () => {
  const cases = [
    {
      workflow: undefined,
      global: 10,
      expected: 10,
      source: "setting queue.maxSteps",
    },
    {
      workflow: undefined,
      global: UNLIMITED_LIMIT,
      expected: UNLIMITED_LIMIT,
      source: "setting queue.maxSteps",
    },
    { workflow: 5, global: 10, expected: 5, source: "workflow maxSteps" },
    {
      workflow: 5,
      global: UNLIMITED_LIMIT,
      expected: 5,
      source: "workflow maxSteps",
    },
    {
      workflow: UNLIMITED_LIMIT,
      global: 10,
      expected: UNLIMITED_LIMIT,
      source: "workflow maxSteps",
    },
    {
      workflow: UNLIMITED_LIMIT,
      global: UNLIMITED_LIMIT,
      expected: UNLIMITED_LIMIT,
      source: "workflow maxSteps",
    },
  ] as const;

  for (const entry of cases) {
    test(`workflow=${String(entry.workflow)}, global=${entry.global}`, () => {
      assert.strictEqual(
        resolveEffectiveMaxSteps(entry.workflow, entry.global),
        entry.expected
      );
      assert.strictEqual(
        getEffectiveMaxStepsSource(entry.workflow),
        entry.source
      );
    });
  }
});
