import assert from "node:assert/strict";
import test from "node:test";
import { assertPricingCorrectionsCurrent } from "./sync-model-pricing.mjs";

const correction = {
  provider: "anthropic",
  modelId: "claude-sonnet-5-5",
  field: "cacheRead",
  upstreamValue: 0.1,
  correctedValue: 0.2,
  reason: "Fixture correction",
};

function registryWithCacheRead(cacheRead) {
  return {
    anthropic: {
      models: {
        "claude-sonnet-5-5": {
          cost: { input: 2, output: 10, cache_read: cacheRead },
        },
      },
    },
  };
}

test("accepts a correction while upstream still has its recorded value", () => {
  assert.doesNotThrow(() =>
    assertPricingCorrectionsCurrent(registryWithCacheRead(0.1), [correction])
  );
});

test("fails when upstream has fixed a correction", () => {
  assert.throws(
    () =>
      assertPricingCorrectionsCurrent(registryWithCacheRead(0.2), [correction]),
    /upstream now has the corrected value.*Remove or update the correction/
  );
});

test("fails when upstream changes to a different value", () => {
  assert.throws(
    () =>
      assertPricingCorrectionsCurrent(registryWithCacheRead(0.25), [
        correction,
      ]),
    /upstream value is 0.25.*Remove or update the correction/
  );
});
