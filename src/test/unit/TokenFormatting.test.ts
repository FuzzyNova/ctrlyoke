import * as assert from "assert";
import {
  ATTEMPT_COST_SOURCES,
  HARNESS_IDS,
  WORKFLOW_TOKEN_COVERAGE,
} from "../../types/DashboardConstants";
import {
  buildAttemptTokenTooltipLines,
  formatCostLabel,
  formatCostTooltip,
  formatAccessibleTokenTotal,
  formatTokenBreakdown,
  formatTokenCount,
  formatTokenTotal,
} from "../../utils/TokenFormatting";

suite("TokenFormatting", () => {
  test("formats compact complete totals", () => {
    assert.strictEqual(formatTokenCount(410_000), "410k");
    assert.strictEqual(
      formatTokenTotal(410_000, WORKFLOW_TOKEN_COVERAGE.COMPLETE),
      "410k"
    );
  });

  test("formats partial totals as lower bounds", () => {
    assert.strictEqual(
      formatTokenTotal(410_000, WORKFLOW_TOKEN_COVERAGE.PARTIAL),
      "≥410k"
    );
    assert.strictEqual(
      formatAccessibleTokenTotal(410_000, WORKFLOW_TOKEN_COVERAGE.PARTIAL),
      "at least 410,000 observed tokens"
    );
  });

  test("formats complete totals accessibly", () => {
    assert.strictEqual(
      formatAccessibleTokenTotal(410_000),
      "410,000 total tokens"
    );
  });

  test("never renders unknown totals as zero", () => {
    assert.strictEqual(formatTokenCount(undefined), "");
    assert.strictEqual(formatTokenTotal(undefined), "");
    assert.strictEqual(formatAccessibleTokenTotal(undefined), "");
    assert.strictEqual(formatTokenTotal(Number.NaN), "");
  });

  test("formats cached input inside the input count for subset harnesses", () => {
    assert.strictEqual(
      formatTokenBreakdown({
        input: 8_500_000,
        output: 22_200,
        total: 8_522_200,
        cached: 8_100_000,
        harness: HARNESS_IDS.CODEX_CLI,
      }),
      "Tokens: 8.5M in (8.1M cached) / 22.2k out / 8.5M total"
    );
  });

  test("keeps cached input additive for disjoint and unknown harnesses", () => {
    const values = {
      input: 242,
      output: 106_400,
      total: 106_642,
      cached: 21_400_000,
    };
    const expected =
      "Tokens: 242 in / 106.4k out / 106.6k total | 21.4M cached";

    assert.strictEqual(
      formatTokenBreakdown({ ...values, harness: HARNESS_IDS.CLAUDE_CLI }),
      expected
    );
    assert.strictEqual(
      formatTokenBreakdown({ ...values, harness: HARNESS_IDS.QWEN_CLI }),
      expected
    );
  });

  test("clarifies context-window and attempt-total scope in the tooltip", () => {
    assert.ok(
      buildAttemptTokenTooltipLines({
        contextWindow: { used: 61_100, size: 258_400 },
        attemptTokens: {
          prompt: 8_500_000,
          completion: 22_200,
          total: 8_522_200,
        },
      }).includes(
        "Current context window is the last turn only; attempt total sums every turn."
      )
    );
  });

  test("labels cost by source and marks partial cost as a lower bound", () => {
    assert.strictEqual(formatCostLabel(0.41), "≈$0.41");
    assert.strictEqual(formatCostLabel(0.41, true), "≥$0.41");
    assert.match(
      formatCostTooltip(0.41, [ATTEMPT_COST_SOURCES.PRICE_TABLE]),
      /at API list prices/
    );
    assert.match(
      formatCostTooltip(0.41, [ATTEMPT_COST_SOURCES.PRICE_TABLE], true),
      /unpriceable/
    );
  });

  test("omits unavailable cost instead of formatting zero", () => {
    assert.strictEqual(formatCostLabel(undefined), "");
  });
});
