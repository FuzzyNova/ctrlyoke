import * as assert from "assert";
import { ATTEMPT_COST_SOURCES } from "../../types/DashboardConstants";
import type { AttemptCostSource } from "../../types/DashboardConstants";
import {
  nonNegativeNumber,
  stableCostSources,
} from "../../core/harness/shared/usage/UsageContributionValues";

suite("UsageContributionValues", () => {
  suite("nonNegativeNumber", () => {
    test("returns zero for negative, non-finite, and non-number values", () => {
      assert.strictEqual(nonNegativeNumber(-1), 0);
      assert.strictEqual(nonNegativeNumber(Number.NaN), 0);
      assert.strictEqual(nonNegativeNumber(Number.POSITIVE_INFINITY), 0);
      assert.strictEqual(nonNegativeNumber("2"), 0);
    });

    test("preserves zero and positive values", () => {
      assert.strictEqual(nonNegativeNumber(0), 0);
      assert.strictEqual(nonNegativeNumber(12.5), 12.5);
    });
  });

  suite("stableCostSources", () => {
    test("returns undefined for missing or empty sources", () => {
      assert.strictEqual(stableCostSources(undefined), undefined);
      assert.strictEqual(stableCostSources([]), undefined);
    });

    test("deduplicates and orders sources by the canonical source order", () => {
      assert.deepStrictEqual(
        stableCostSources([
          ATTEMPT_COST_SOURCES.USER_OVERRIDE,
          ATTEMPT_COST_SOURCES.HARNESS_REPORTED,
          ATTEMPT_COST_SOURCES.USER_OVERRIDE,
        ]),
        [
          ATTEMPT_COST_SOURCES.HARNESS_REPORTED,
          ATTEMPT_COST_SOURCES.USER_OVERRIDE,
        ]
      );
    });

    test("returns undefined when all sources are unknown", () => {
      assert.strictEqual(
        stableCostSources(["unknown"] as unknown as AttemptCostSource[]),
        undefined
      );
    });
  });
});
