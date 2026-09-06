import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { OutputScrollSeekPlaceholder } from "@components/layout/output-section/OutputScrollSeekPlaceholder";
import { getStepIdentityBarStyle } from "@components/output/outputStyles";
import type { PlainResponseRow } from "@utils/outputRows";
import { OUTPUT_ROW_KINDS } from "@root/types/DashboardConstants";
import { FINAL_STEP_PHASES } from "@/types/messages";

const TARGET = { kind: FINAL_STEP_PHASES.QUEUE, index: 0 } as const;

function buildPlainResponseRow(stepColor?: string): PlainResponseRow {
  return {
    key: "row-placeholder",
    target: TARGET,
    estimateSize: 400,
    rowKind: OUTPUT_ROW_KINDS.PLAIN_RESPONSE,
    text: "x".repeat(2000),
    rawTextOutput: false,
    animated: false,
    stepColor,
  };
}

describe("OutputScrollSeekPlaceholder step identity bar", () => {
  it("paints the row's step color so fast scrolling shows a continuous bar", () => {
    const stepColor = "#123456";
    const { container } = render(
      <OutputScrollSeekPlaceholder
        row={buildPlainResponseRow(stepColor)}
        height={40}
      />
    );

    const bar = container.querySelector("[data-step-color-bar]");
    expect(bar).not.toBeNull();
    expect(bar).toHaveStyle(getStepIdentityBarStyle(stepColor));
  });

  it("renders without a bar when the row has no step color", () => {
    const { container } = render(
      <OutputScrollSeekPlaceholder row={buildPlainResponseRow()} height={40} />
    );

    expect(container.querySelector("[data-step-color-bar]")).toBeNull();
  });
});
