import * as assert from "assert";
import {
  ATTEMPT_COST_CACHE_RELATIONSHIPS,
  ATTEMPT_COST_CONFIDENCE,
  ATTEMPT_COST_NOTE_CODES,
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

  test("uses the evidence-backed token semantics for Qwen, Antigravity, and OpenCode", () => {
    assert.strictEqual(
      HARNESS_TOKEN_SEMANTICS[HARNESS_IDS.QWEN_CLI].cacheInputRelationship,
      ATTEMPT_COST_CACHE_RELATIONSHIPS.SUBSET
    );
    assert.strictEqual(
      HARNESS_TOKEN_SEMANTICS[HARNESS_IDS.ANTIGRAVITY_CLI]
        .cacheInputRelationship,
      ATTEMPT_COST_CACHE_RELATIONSHIPS.DISJOINT
    );
    assert.strictEqual(
      HARNESS_TOKEN_SEMANTICS[HARNESS_IDS.OPENCODE_CLI].cacheInputRelationship,
      ATTEMPT_COST_CACHE_RELATIONSHIPS.DISJOINT
    );
    assert.strictEqual(
      HARNESS_TOKEN_SEMANTICS[HARNESS_IDS.QWEN_CLI].reasoningRelationship,
      ATTEMPT_COST_REASONING_RELATIONSHIPS.INCLUDED_IN_OUTPUT
    );
    assert.strictEqual(
      HARNESS_TOKEN_SEMANTICS[HARNESS_IDS.ANTIGRAVITY_CLI]
        .reasoningRelationship,
      ATTEMPT_COST_REASONING_RELATIONSHIPS.INCLUDED_IN_OUTPUT
    );
    assert.strictEqual(
      HARNESS_TOKEN_SEMANTICS[HARNESS_IDS.OPENCODE_CLI].reasoningRelationship,
      ATTEMPT_COST_REASONING_RELATIONSHIPS.DISJOINT
    );
    assert.strictEqual(
      HARNESS_TOKEN_SEMANTICS[HARNESS_IDS.COPILOT_CLI].reasoningRelationship,
      ATTEMPT_COST_REASONING_RELATIONSHIPS.INCLUDED_IN_OUTPUT
    );
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
      semantics(
        ATTEMPT_COST_CACHE_RELATIONSHIPS.UNKNOWN,
        ATTEMPT_COST_REASONING_RELATIONSHIPS.UNKNOWN
      ),
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

  test("uses Claude harness dollars when they agree with the table", () => {
    const table = calculateAttemptCost({
      harnessId: HARNESS_IDS.CLAUDE_CLI,
      modelId: "sonnet",
      prompt: 1_000_000,
      completion: 0,
      harnessReportedCostUsd: 2.1,
    });

    assert.strictEqual(
      table.cost?.source,
      ATTEMPT_COST_SOURCES.HARNESS_REPORTED
    );
    assert.strictEqual(table.cost?.usd, 2.1);
  });

  test("falls back to the table and marks Claude divergence beyond 2x", () => {
    const result = calculateAttemptCost({
      harnessId: HARNESS_IDS.CLAUDE_CLI,
      modelId: "sonnet",
      prompt: 1_000_000,
      completion: 0,
      harnessReportedCostUsd: 10,
    });

    assert.strictEqual(result.cost?.source, ATTEMPT_COST_SOURCES.PRICE_TABLE);
    assert.strictEqual(
      result.cost?.noteCode,
      ATTEMPT_COST_NOTE_CODES.HARNESS_DIVERGENCE
    );
    assert.ok((result.cost?.usd ?? 0) < 10);
  });

  test("uses a configured override when the table value is absent", () => {
    const result = calculateAttemptCost({
      harnessId: HARNESS_IDS.CLAUDE_CLI,
      modelId: "byo-model",
      prompt: 1_000_000,
      completion: 0,
      pricingOverride: { inputPerMTok: 3, outputPerMTok: 15 },
    });

    assert.strictEqual(result.cost?.source, ATTEMPT_COST_SOURCES.USER_OVERRIDE);
    assert.strictEqual(result.cost?.usd, 3);
  });

  test("prefers a configured override over a bundled table entry", () => {
    const result = calculateAttemptCost({
      harnessId: HARNESS_IDS.CLAUDE_CLI,
      modelId: "sonnet",
      prompt: 1_000_000,
      completion: 0,
      pricingOverride: { inputPerMTok: 7, outputPerMTok: 15 },
    });

    assert.strictEqual(result.cost?.source, ATTEMPT_COST_SOURCES.USER_OVERRIDE);
    assert.strictEqual(result.cost?.usd, 7);
  });

  test("accepts OpenCode harness dollars without a bundled model table", () => {
    const result = calculateAttemptCost({
      harnessId: HARNESS_IDS.OPENCODE_CLI,
      modelId: "provider/unknown-model",
      prompt: 1_000_000,
      completion: 1_000_000,
      harnessReportedCostUsd: 0.42,
    });

    assert.strictEqual(
      result.cost?.source,
      ATTEMPT_COST_SOURCES.HARNESS_REPORTED
    );
    assert.strictEqual(result.cost?.usd, 0.42);
  });

  test("calculates a token-based estimate for Copilot from the bundled table", () => {
    const result = calculateAttemptCost({
      harnessId: HARNESS_IDS.COPILOT_CLI,
      modelId: "claude-sonnet-4.6",
      prompt: 1_000_000,
      completion: 1_000_000,
    });

    assert.strictEqual(result.cost?.source, ATTEMPT_COST_SOURCES.PRICE_TABLE);
    assert.strictEqual(result.cost?.usd, 3 + 15);
  });

  test("prices Copilot cache reads separately from normalized input", () => {
    const result = calculateAttemptCost({
      harnessId: HARNESS_IDS.COPILOT_CLI,
      modelId: "gpt-5.6-luna",
      prompt: 100_000,
      cached: 900_000,
      completion: 1_000,
    });

    // Copilot input is normalized to exclude cache counts. Its registry rates
    // are $0.20/M input, $0.02/M cached input, and $1.20/M output.
    assert.ok(Math.abs((result.cost?.usd ?? 0) - 0.0392) < 1e-12);
    assert.ok(
      Math.abs((result.cost?.breakdown?.cachedInputUsd ?? 0) - 0.018) < 1e-12
    );
    assert.ok(Math.abs((result.cost?.breakdown?.inputUsd ?? 0) - 0.02) < 1e-12);
  });

  test("prices Copilot cache counts without charging them as input again", () => {
    const result = calculateAttemptCost({
      harnessId: HARNESS_IDS.COPILOT_CLI,
      modelId: "claude-sonnet-4.6",
      prompt: 6,
      cached: 31_232,
      cacheCreated: 32_516,
      completion: 484,
      pricingOverride: {
        inputPerMTok: 1.25,
        outputPerMTok: 10,
        cachedInputPerMTok: 0.125,
        cacheWritePerMTok: 1.25,
      },
    });

    assert.ok(Math.abs((result.cost?.usd ?? 0) - 0.0493965) < 1e-12);
    assert.ok(
      Math.abs((result.cost?.breakdown?.inputUsd ?? 0) - 0.0000075) < 1e-12
    );
  });

  test("prices disjoint reasoning at the output rate when no reasoning rate exists", () => {
    const pricing: ModelPricing = {
      inputPerMTok: 2,
      outputPerMTok: 7,
      sourceUrl: "https://example.test/pricing",
      verifiedOn: "2026-08-09",
    };
    const result = calculateTokenCost(
      pricing,
      HARNESS_TOKEN_SEMANTICS[HARNESS_IDS.OPENCODE_CLI],
      { prompt: 24_073, completion: 207, reasoning: 749 }
    );

    assert.strictEqual(result?.breakdown?.reasoningUsd, (749 / 1_000_000) * 7);
    assert.strictEqual(
      result?.usd,
      (24_073 / 1_000_000) * 2 + ((207 + 749) / 1_000_000) * 7
    );
  });

  test("reports unknown model for a Copilot model absent from the bundled table", () => {
    const result = calculateAttemptCost({
      harnessId: HARNESS_IDS.COPILOT_CLI,
      modelId: "some-future-copilot-model",
      prompt: 1_000,
      completion: 100,
    });

    assert.strictEqual(result.cost, undefined);
    assert.strictEqual(
      result.costUnavailableReason,
      ATTEMPT_COST_UNAVAILABLE_REASONS.UNKNOWN_MODEL
    );
  });
});
