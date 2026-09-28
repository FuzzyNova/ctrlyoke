import { describe, expect, it } from "vitest";
import {
  DEFAULT_COLLAPSED_OUTPUT_MAX_CHARS,
  MAX_COLLAPSED_OUTPUT_MAX_CHARS,
  buildCollapsedSingleLinePreview,
  buildCollapsedOutputPreview,
  formatCollapsedOutputToggleLabel,
  formatScriptOutputTailToggleLabel,
  getCollapsedOutputMaxChars,
  splitTextIntoLineSegments,
  takeTrailingLines,
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

  it("does not count a trailing newline as an extra output line", () => {
    const preview = buildCollapsedOutputPreview("a\nb\nc\nd\ne\n", {
      expanded: false,
      maxLines: 3,
      maxChars: 1000,
    });

    expect(preview).toMatchObject({
      fullLineCount: 5,
      visibleLineCount: 3,
      hiddenLineCount: 2,
      isTruncated: true,
    });
    expect(formatCollapsedOutputToggleLabel(preview, false)).toBe(
      "[show 2 more lines]"
    );
  });

  it("shows all output when a trailing newline leaves only one hidden line", () => {
    const preview = buildCollapsedOutputPreview("a\nb\nc\nd\n", {
      expanded: false,
      maxLines: 3,
      maxChars: 1000,
    });

    expect(preview).toMatchObject({
      fullLineCount: 4,
      visibleLineCount: 4,
      hiddenLineCount: 0,
      visibleText: "a\nb\nc\nd\n",
      isTruncated: false,
    });
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

  describe("script output windowing", () => {
    const lines = (count: number) =>
      Array.from({ length: count }, (_, index) => `line ${index + 1}`);

    it("splits into segments that rejoin to the original text", () => {
      const text = lines(7).join("\n");
      const segments = splitTextIntoLineSegments(text, 3);

      expect(segments).toEqual([
        "line 1\nline 2\nline 3",
        "line 4\nline 5\nline 6",
        "line 7",
      ]);
      expect(segments.join("\n")).toBe(text);
    });

    it("does not open an empty segment for a trailing newline", () => {
      expect(splitTextIntoLineSegments("line 1\nline 2\n", 2)).toEqual([
        "line 1\nline 2",
      ]);
      expect(splitTextIntoLineSegments("", 3)).toEqual([]);
    });

    it("preserves blank lines inside the output", () => {
      expect(splitTextIntoLineSegments("a\n\nb\n\nc", 2)).toEqual([
        "a\n",
        "b\n",
        "c",
      ]);
    });

    it("keeps only the trailing window and reports what it dropped", () => {
      const window = takeTrailingLines(lines(10).join("\n"), 3);

      expect(window.text).toBe("line 8\nline 9\nline 10");
      expect(window.hiddenLineCount).toBe(7);
      expect(window.totalLineCount).toBe(10);
    });

    it("returns the whole text when it is shorter than the window", () => {
      const window = takeTrailingLines("line 1\nline 2", 30);

      expect(window.text).toBe("line 1\nline 2");
      expect(window.hiddenLineCount).toBe(0);
      expect(window.totalLineCount).toBe(2);
    });

    it("labels the toggle by which direction the hidden lines are in", () => {
      expect(formatScriptOutputTailToggleLabel(42, false)).toBe(
        "[show full output — 42 earlier lines]"
      );
      expect(formatScriptOutputTailToggleLabel(1, false)).toBe(
        "[show full output — 1 earlier line]"
      );
      expect(formatScriptOutputTailToggleLabel(42, true)).toBe("[show less]");
    });
  });
});
