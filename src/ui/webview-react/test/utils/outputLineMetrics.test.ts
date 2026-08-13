import { describe, expect, it } from "vitest";
import {
  DIFF_GAP_DECORATION_VERTICAL_PADDING,
  DIFF_LINE_HEIGHT,
  OUTPUT_RELAXED_LINE_HEIGHT,
  OUTPUT_ROW_HORIZONTAL_PADDING,
  diffCharWidth,
  diffCodeColumns,
  diffGapDecorationHeight,
  diffHorizontalChrome,
  diffLineHeight,
} from "@utils/outputLineMetrics";

// These are CSS values read off the rendered diff table, not fitted constants,
// so each assertion below names the rule it mirrors. A failure here means the
// markup moved and the estimator has to follow it — not that a number needs
// re-tuning.
describe("diff geometry", () => {
  describe("diffLineHeight", () => {
    it("follows `.diff { font-size: sm }` and `.diff-line { line-height: 1.5 }`", () => {
      expect(diffLineHeight(13)).toBeCloseTo(18);
      expect(diffLineHeight(16)).toBeCloseTo(22.5);
      expect(diffLineHeight(20)).toBeCloseTo((20 - 1) * DIFF_LINE_HEIGHT);
    });

    // The predecessor floored at 18px, which over-predicted every row for any
    // base font below 13 — a compounding error on long diffs.
    it("keeps scaling below the default font size", () => {
      expect(diffLineHeight(12)).toBeCloseTo(16.5);
      expect(diffLineHeight(11)).toBeLessThan(diffLineHeight(12));
    });
  });

  describe("diffGapDecorationHeight", () => {
    it("matches the xs header line height plus its own py-0.5 padding", () => {
      expect(diffGapDecorationHeight(13)).toBeCloseTo(
        (13 - 2) * OUTPUT_RELAXED_LINE_HEIGHT +
          DIFF_GAP_DECORATION_VERTICAL_PADDING
      );
    });

    it("scales with the output font size", () => {
      expect(diffGapDecorationHeight(16)).toBeGreaterThan(
        diffGapDecorationHeight(13)
      );
    });
  });

  describe("diffCodeColumns", () => {
    it("gives split a code column per side and unified a single one", () => {
      expect(diffCodeColumns("unified")).toBe(1);
      expect(diffCodeColumns("split")).toBe(2);
    });
  });

  describe("diffHorizontalChrome", () => {
    // Both view types render two `width: 7ch` gutter columns; only the count of
    // `padding-left: .5em` code cells differs. So split costs exactly one extra
    // code-cell padding, and nothing else.
    it("charges split exactly one more code-cell padding than unified", () => {
      const fontSize = 16;
      expect(
        diffHorizontalChrome("split", fontSize) -
          diffHorizontalChrome("unified", fontSize)
      ).toBeCloseTo(0.5 * (fontSize - 1));
    });

    it("is built from the row padding, border, gutters and code padding", () => {
      const fontSize = 13;
      expect(diffHorizontalChrome("unified", fontSize)).toBeCloseTo(
        OUTPUT_ROW_HORIZONTAL_PADDING +
          2 +
          2 * 7 * diffCharWidth(fontSize) +
          0.5 * (fontSize - 1)
      );
    });

    // The calibrated constants this replaced were 168 unified / 224 split, plus
    // a 24px inter-column gap a `table-layout: fixed` table does not have. On a
    // phone that ~50px is 13% of the pane, and it made every wrap-bound diff
    // estimate run long by 15-20%.
    it("costs materially less than the constants it replaced", () => {
      expect(diffHorizontalChrome("unified", 13)).toBeLessThan(168);
      expect(diffHorizontalChrome("split", 13)).toBeLessThan(224);
    });

    it("scales with the font size rather than sitting at a fixed pixel count", () => {
      expect(diffHorizontalChrome("unified", 20)).toBeGreaterThan(
        diffHorizontalChrome("unified", 13)
      );
    });
  });

  describe("diffCharWidth", () => {
    it("measures the glyph at the diff's own font size, one below the base", () => {
      expect(diffCharWidth(13)).toBeCloseTo(12 * 0.55);
      expect(diffCharWidth(16)).toBeCloseTo(15 * 0.55);
    });

    it("never collapses to an absurdly narrow glyph", () => {
      expect(diffCharWidth(6)).toBeGreaterThanOrEqual(5.5);
    });
  });
});
