import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowStepItem } from "@components/prompts/WorkflowStep";
import { STEP_STATUS, type CliOutput } from "@/types/messages";
import { CTRLYOKE_SETTINGS_DEFAULTS } from "@root/types/CtrlYokeSettings";
import { useSettingsStore } from "@store/settingsStore";
import type { FullGlobalSettings } from "@root/types/WebviewMessageTypes";
import type { UsagePercentDirection } from "@root/utils/StatuslineFormat";

function buildOutput(
  compactionCount: number | undefined,
  contextWindowUsed = 10000
): CliOutput {
  return {

    structured: { events: [{ type: "text", data: { text: "Done" } }], metadata: {} },
    elapsed: 1,
    isStreaming: false,
    tokens: {
      prompt: 8000,
      completion: 12000,
      total: 410000,
      contextWindowUsed,
      contextWindowSize: 200000,
      compactionCount,
    },
  };
}

function renderStep(
  compactionCount: number | undefined,
  contextWindowUsed?: number
) {
  return render(
    <WorkflowStepItem
      text="Review the changes"
      index={0}
      status={STEP_STATUS.COMPLETED}
      latestOutput={buildOutput(compactionCount, contextWindowUsed)}
    />
  );
}

function setPercentDirection(direction: UsagePercentDirection) {
  useSettingsStore.setState({
    fullGlobalSettings: {
      settings: {
        ...CTRLYOKE_SETTINGS_DEFAULTS,
        usageTracking: {
          ...CTRLYOKE_SETTINGS_DEFAULTS.usageTracking,
          percentDirection: direction,
        },
      },
      sources: {},
      isMultiRoot: false,
    } satisfies FullGlobalSettings,
  });
}

describe("WorkflowStep token usage", () => {
  beforeEach(() => {
    setPercentDirection("used");
  });

  it("shows a compaction badge above the percentage bar after compaction", () => {
    const { container } = renderStep(2);

    expect(container.querySelector(".codicon-fold")).not.toBeNull();
    expect(container.querySelector("[title='Compactions: 2']")).not.toBeNull();
    expect(container).toHaveTextContent("410k tks");
    expect(
      container.querySelector("[title*='Attempt total: 410k']")
    ).not.toBeNull();
  });

  it("activates the workflow-step row from Space", () => {
    const onClick = vi.fn();

    render(
      <WorkflowStepItem
        text="Review the changes"
        index={0}
        status={STEP_STATUS.COMPLETED}
        onClick={onClick}
      />
    );

    fireEvent.keyDown(screen.getByRole("button", { name: "Step 1" }), {
      key: " ",
    });

    expect(onClick).toHaveBeenCalledOnce();
  });

  it("always shows the attempt total in compact stats, uncompacted", () => {
    const { container } = renderStep(0);

    expect(container.querySelector(".codicon-fold")).toBeNull();
    expect(container).toHaveTextContent("410k tks");
    expect(
      container.querySelector("[title*='Attempt total: 410k']")
    ).not.toBeNull();
  });

  it("does not infer compaction when its count is unavailable", () => {
    const { container } = renderStep(undefined);

    expect(container.querySelector(".codicon-fold")).toBeNull();
    expect(container).toHaveTextContent("410k tks");
    expect(
      container.querySelector("[title*='Attempt total: 410k']")
    ).not.toBeNull();
  });

  it.each(["used", "remaining"] as const)(
    "keeps context-bar danger coloring used%-based in %s mode",
    (direction) => {
      setPercentDirection(direction);
      const { container } = renderStep(undefined, 180000);
      const contextFill = container.querySelector('[style="height: 90%;"]');

      expect(contextFill).toHaveClass("bg-error-fg");
      expect(contextFill).toHaveClass("opacity-90");
    }
  );
});
