import * as assert from "assert";
import {
  ATTEMPT_COST_CACHE_RELATIONSHIPS,
  ATTEMPT_COST_CONFIDENCE,
  ATTEMPT_COST_REASONING_RELATIONSHIPS,
  ATTEMPT_COST_SOURCES,
  ATTEMPT_COST_UNAVAILABLE_REASONS,
  HARNESS_IDS,
  TOKEN_TOTAL_CONFIDENCE,
} from "../../types/DashboardConstants";
import {
  calculateAttemptCost,
  calculateTokenCost,
  HARNESS_TOKEN_SEMANTICS,
  type HarnessTokenSemantics,
  type ModelPricing,
} from "../../utils/ModelPricing";

const testPricing: ModelPricing = {
  inputPerMTok: 10,
  outputPerMTok: 20,
  cachedInputPerMTok: 1,
  cacheWritePerMTok: 4,
  reasoningPerMTok: 30,
  sourceUrl: "https://example.test/pricing",
  verifiedOn: "2026-08-09",
};

function semantics(
  cacheInputRelationship: HarnessTokenSemantics["cacheInputRelationship"],
  reasoningRelationship: HarnessTokenSemantics["reasoningRelationship"]
): HarnessTokenSemantics {
  return { cacheInputRelationship, reasoningRelationship };
}

suite("ModelPricing", () => {
  test("uses different totals for subset and disjoint cache counts", () => {
    const tokens = { prompt: 1_000_000, completion: 0, cached: 900_000 };
    const subset = calculateTokenCost(
      testPricing,
      semantics(
        ATTEMPT_COST_CACHE_RELATIONSHIPS.SUBSET,
        ATTEMPT_COST_REASONING_RELATIONSHIPS.UNREPORTED
      ),
      tokens
    );
    const disjoint = calculateTokenCost(
      testPricing,
      semantics(
        ATTEMPT_COST_CACHE_RELATIONSHIPS.DISJOINT,
        ATTEMPT_COST_REASONING_RELATIONSHIPS.UNREPORTED
      ),
      tokens
    );

    assert.strictEqual(subset?.usd, 1.9);
    assert.strictEqual(disjoint?.usd, 10.9);
  });

  test("does not double count reasoning already included in output", () => {
    const included = calculateTokenCost(
      testPricing,
      semantics(
        ATTEMPT_COST_CACHE_RELATIONSHIPS.DISJOINT,
        ATTEMPT_COST_REASONING_RELATIONSHIPS.INCLUDED_IN_OUTPUT
      ),
      { prompt: 0, completion: 1_000_000, reasoning: 500_000 }
    );
    const disjoint = calculateTokenCost(
      testPricing,
      semantics(
        ATTEMPT_COST_CACHE_RELATIONSHIPS.DISJOINT,
        ATTEMPT_COST_REASONING_RELATIONSHIPS.DISJOINT
      ),
      { prompt: 0, completion: 1_000_000, reasoning: 500_000 }
    );

    assert.strictEqual(included?.usd, 20);
    assert.strictEqual(included?.breakdown?.reasoningUsd, 0);
    assert.strictEqual(disjoint?.usd, 35);
  });

  test("omits unknown models instead of returning zero", () => {
    const result = calculateAttemptCost({
      harnessId: HARNESS_IDS.CLAUDE_CLI,
      modelId: "byo-model",
      prompt: 1_000,
      completion: 100,
    });

    assert.strictEqual(result.cost, undefined);
    assert.strictEqual(
      result.costUnavailableReason,
      ATTEMPT_COST_UNAVAILABLE_REASONS.UNKNOWN_MODEL
    );
  });

  test("suppresses table pricing when semantics are unknown", () => {
    const result = calculateTokenCost(
      testPricing,
      HARNESS_TOKEN_SEMANTICS[HARNESS_IDS.QWEN_CLI],
      { prompt: 1_000, completion: 100 }
    );

    assert.strictEqual(result, undefined);
  });

  test("suppresses estimates for partial token totals", () => {
    const result = calculateAttemptCost({
      harnessId: HARNESS_IDS.CLAUDE_CLI,
      modelId: "sonnet",
      prompt: 1_000,
      completion: 100,
      totalConfidence: TOKEN_TOTAL_CONFIDENCE.PARTIAL,
    });

    assert.strictEqual(result.cost, undefined);
    assert.strictEqual(
      result.costUnavailableReason,
      ATTEMPT_COST_UNAVAILABLE_REASONS.PARTIAL_TOKENS
    );
  });

  test("marks table estimates as complete and price-table sourced", () => {
    const result = calculateAttemptCost({
      harnessId: HARNESS_IDS.CLAUDE_CLI,
      modelId: "sonnet",
      prompt: 1_000,
      completion: 100,
    });

    assert.strictEqual(result.cost?.source, ATTEMPT_COST_SOURCES.PRICE_TABLE);
    assert.strictEqual(
      result.cost?.confidence,
      ATTEMPT_COST_CONFIDENCE.COMPLETE
    );
  });
});
