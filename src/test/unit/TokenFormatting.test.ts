import * as assert from "assert";
import {
  ATTEMPT_COST_SOURCES,
  WORKFLOW_TOKEN_COVERAGE,
} from "../../types/DashboardConstants";
import {
  formatCostLabel,
  formatCostTooltip,
  formatAccessibleTokenTotal,
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
