import { describe, expect, it } from "vitest";
import {
  buildToolCallRenderPlan,
  getVisibleToolCallText,
} from "@utils/toolCallLayout";

describe("toolCallLayout", () => {
  const parameters = {
    subject: "output-layout",
    detail: "lift expansion state",
  };
  const output = Array.from(
    { length: 12 },
    (_, index) => `line ${index + 1}`
  ).join("\n");
  const error = Array.from(
    { length: 11 },
    (_, index) => `error ${index + 1}`
  ).join("\n");

  it("builds collapsed section render plans for params, output, and error", () => {
    const renderPlan = buildToolCallRenderPlan({
      parameters,
      result: {
        success: false,
        output,
        error,
      },
      expansion: {
        paramsExpanded: false,
        outputExpanded: false,
        errorExpanded: false,
      },
      outputFontSize: 13,
    });

    expect(renderPlan.summaryHeight).toBeGreaterThan(0);
    expect(renderPlan.paramsLineCount).toBe(2);
    expect(renderPlan.params.visibleLineCount).toBe(0);
    expect(renderPlan.params.hiddenLineCount).toBe(2);
    expect(renderPlan.params.height).toBe(0);
    expect(renderPlan.outputLineCount).toBe(12);
    expect(renderPlan.output.visibleLineCount).toBe(10);
    expect(renderPlan.output.hiddenLineCount).toBe(2);
    expect(renderPlan.isOutputTruncated).toBe(true);
    expect(renderPlan.errorLineCount).toBe(11);
    // Single hidden line: the collapsed preview shows the full text rather than
    // adding a toggle control that wastes as much vertical space as the one line
    // it would hide (see buildCollapsedOutputPreview's single-line passthrough).
    expect(renderPlan.error.visibleLineCount).toBe(11);
    expect(renderPlan.error.hiddenLineCount).toBe(0);
    expect(renderPlan.isErrorTruncated).toBe(false);
    expect(getVisibleToolCallText(output, renderPlan.output)).toContain("line 10");
    expect(getVisibleToolCallText(output, renderPlan.output)).not.toContain("line 11");
    expect(renderPlan.totalHeight).toBe(
      renderPlan.summaryHeight +
        renderPlan.paramsHeight +
        renderPlan.outputHeight +
        renderPlan.errorHeight
    );
  });

  it("builds expanded section render plans without truncation", () => {
    const collapsed = buildToolCallRenderPlan({
      parameters,
      result: {
        success: false,
        output,
        error,
      },
      expansion: {
        paramsExpanded: false,
        outputExpanded: false,
        errorExpanded: false,
      },
      outputFontSize: 13,
    });
    const expanded = buildToolCallRenderPlan({
      parameters,
      result: {
        success: false,
        output,
        error,
      },
      expansion: {
        paramsExpanded: true,
        outputExpanded: true,
        errorExpanded: true,
      },
      outputFontSize: 13,
    });

    expect(expanded.params.visibleLineCount).toBe(2);
    expect(expanded.params.hiddenLineCount).toBe(0);
    expect(expanded.params.height).toBeGreaterThan(0);
    expect(expanded.output.visibleLineCount).toBe(12);
    expect(expanded.output.hiddenLineCount).toBe(0);
    expect(expanded.error.visibleLineCount).toBe(11);
    expect(expanded.error.hiddenLineCount).toBe(0);
    expect(getVisibleToolCallText(error, expanded.error)).toContain("error 11");
    expect(expanded.totalHeight).toBeGreaterThan(collapsed.totalHeight);
  });

  it("caps collapsed result preview by character count for long single lines", () => {
    const longOutput = "x".repeat(1600);
    const renderPlan = buildToolCallRenderPlan({
      result: {
        success: true,
        output: longOutput,
      },
      expansion: {
        paramsExpanded: false,
        outputExpanded: false,
        errorExpanded: false,
      },
      outputFontSize: 13,
    });

    expect(renderPlan.output.visibleText).toHaveLength(1200);
    expect(renderPlan.output.visibleLineCount).toBe(1);
    expect(renderPlan.output.hiddenLineCount).toBe(0);
    expect(getVisibleToolCallText(longOutput, renderPlan.output)).toHaveLength(
      1200
    );
  });
});
