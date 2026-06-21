import { describe, expect, it } from "vitest";
import {
  buildCollapsedSingleLinePreview,
  buildCollapsedOutputPreview,
  formatCollapsedOutputToggleLabel,
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
