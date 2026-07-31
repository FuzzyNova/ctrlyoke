import { describe, expect, it } from "vitest";
import {
  DEFAULT_COLLAPSED_OUTPUT_MAX_CHARS,
  MAX_COLLAPSED_OUTPUT_MAX_CHARS,
  buildCollapsedSingleLinePreview,
  buildCollapsedOutputPreview,
  formatCollapsedOutputToggleLabel,
  getCollapsedOutputMaxChars,
} from "@utils/outputTruncation";

describe("outputTruncation", () => {
  it("truncates by raw line count and reports hidden lines", () => {
    const text = Array.from(
      { length: 12 },
      (_, index) => `line ${index + 1}`
    ).join("\n");

    const preview = buildCollapsedOutputPreview(text, {
      expanded: false,
      maxLines: 10,
      maxChars: 1200,
    });

    expect(preview.isTruncated).toBe(true);
    expect(preview.visibleText).toContain("line 10");
    expect(preview.visibleText).not.toContain("line 11");
    expect(preview.hiddenLineCount).toBe(2);
    expect(formatCollapsedOutputToggleLabel(preview, false)).toBe(
      "[show 2 more lines]"
    );
  });

  it("truncates a long single line by character count", () => {
    const text = "x".repeat(1600);

    const preview = buildCollapsedOutputPreview(text, {
      expanded: false,
      maxLines: 10,
      maxChars: 1200,
    });

    expect(preview.isTruncated).toBe(true);
    expect(preview.visibleText).toHaveLength(1200);
    expect(preview.hiddenLineCount).toBe(0);
    expect(formatCollapsedOutputToggleLabel(preview, false)).toBe(
      "[show more output]"
    );
  });

  it("scales the character budget with the requested visible lines and content width", () => {
    const narrow = getCollapsedOutputMaxChars({
      maxLines: 3,
      contentWidth: 320,
      outputFontSize: 12,
      horizontalChrome: 72,
    });
    const wide = getCollapsedOutputMaxChars({
      maxLines: 3,
      contentWidth: 1080,
      outputFontSize: 12,
      horizontalChrome: 72,
    });

    expect(narrow).toBeLessThan(wide);
    expect(
      getCollapsedOutputMaxChars({
        maxLines: 100,
        contentWidth: 1080,
        outputFontSize: 12,
        horizontalChrome: 72,
      })
    ).toBeGreaterThan(DEFAULT_COLLAPSED_OUTPUT_MAX_CHARS);
    expect(
      getCollapsedOutputMaxChars({
        maxLines: 10_000,
        contentWidth: 10_000,
        outputFontSize: 12,
      })
    ).toBe(MAX_COLLAPSED_OUTPUT_MAX_CHARS);
  });

  it("uses the stable fallback character budget until output geometry is known", () => {
    expect(
      getCollapsedOutputMaxChars({
        maxLines: 3,
        outputFontSize: 12,
      })
    ).toBe(DEFAULT_COLLAPSED_OUTPUT_MAX_CHARS);
  });

  it("flattens embedded newlines when building a single-line preview", () => {
    const preview = buildCollapsedSingleLinePreview("alpha\nbeta\ngamma", {
      expanded: false,
      maxChars: 9,
    });

    expect(preview.visibleText).toBe("alpha bet");
    expect(preview.hiddenLineCount).toBe(0);
    expect(preview.isTruncated).toBe(true);
  });
});
