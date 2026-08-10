import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WorkflowStepItem } from "@components/prompts/WorkflowStep";
import { STEP_STATUS, type CliOutput } from "@/types/messages";

function buildOutput(compactionCount: number | undefined): CliOutput {
  return {
    prompt: "Review the changes",
    response: "Done",
    elapsed: 1,
    isStreaming: false,
    tokens: {
      prompt: 8000,
      completion: 12000,
      total: 410000,
      contextWindowUsed: 10000,
      contextWindowSize: 200000,
      compactionCount,
    },
  };
}

function renderStep(compactionCount: number | undefined) {
  return render(
    <WorkflowStepItem
      text="Review the changes"
      index={0}
      status={STEP_STATUS.COMPLETED}
      latestOutput={buildOutput(compactionCount)}
    />
  );
}

describe("WorkflowStep token usage", () => {
  it("shows the attempt total beside the percentage after compaction", () => {
    const { container } = renderStep(2);

    expect(container).toHaveTextContent("5% · 410k");
    expect(
      container.querySelector("[title*='Attempt total: 410k']")
    ).not.toBeNull();
  });

  it("keeps a large uncompacted total in the tooltip", () => {
    const { container } = renderStep(0);

    expect(container).toHaveTextContent("5%");
    expect(container).not.toHaveTextContent("410k");
    expect(
      container.querySelector("[title*='Attempt total: 410k']")
    ).not.toBeNull();
  });

  it("does not infer compaction when its count is unavailable", () => {
    const { container } = renderStep(undefined);

    expect(container).toHaveTextContent("5%");
    expect(container).not.toHaveTextContent("410k");
    expect(
      container.querySelector("[title*='Attempt total: 410k']")
    ).not.toBeNull();
  });
});
