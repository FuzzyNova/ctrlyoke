import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FINAL_STEP_PHASES } from "@root/types/DashboardConstants";
import {
  OutputMinimap,
  type MinimapStep,
} from "@components/output/OutputMinimap";

function makeStep(overrides: Partial<MinimapStep> = {}): MinimapStep {
  return {
    key: "queue:2",
    kind: FINAL_STEP_PHASES.QUEUE,
    stepIndex: 2,
    firstMessageIndex: 0,
    scrollFraction: 0.2,
    label: "research-db",
    hidden: false,
    hasHiddenActivity: false,
    undoActions: { undo: null, redo: null },
    diffBlocks: [],
    ...overrides,
  };
}

function renderMinimap(steps: MinimapStep[]) {
  const scrollContainerRef = {
    current: document.createElement("div"),
  };
  Object.defineProperty(scrollContainerRef.current, "clientHeight", {
    configurable: true,
    value: 100,
  });
  return render(
    <OutputMinimap
      steps={steps}
      scrollContainerRef={scrollContainerRef}
      contentHeight={100}
    />
  );
}

describe("OutputMinimap step visibility controls", () => {
  it("renders an accessible eye control for each step", () => {
    renderMinimap([
      makeStep(),
      makeStep({ key: "queue:3", stepIndex: 3, label: "deploy" }),
    ]);

    expect(
      screen.getByRole("button", { name: "Hide step 3 output" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Hide step 4 output" })
    ).toBeInTheDocument();
  });

  it("toggles a step through its eye control", () => {
    const onStepToggle = vi.fn();
    const step = makeStep();
    render(
      <OutputMinimap
        steps={[step]}
        scrollContainerRef={{ current: document.createElement("div") }}
        contentHeight={100}
        onStepToggle={onStepToggle}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Hide step 3 output" }));

    expect(onStepToggle).toHaveBeenCalledWith(step);
  });

  it("solos a step on Alt-click", () => {
    const onStepSolo = vi.fn();
    const step = makeStep();
    render(
      <OutputMinimap
        steps={[step]}
        scrollContainerRef={{ current: document.createElement("div") }}
        contentHeight={100}
        onStepSolo={onStepSolo}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "research-db" }), {
      altKey: true,
    });

    expect(onStepSolo).toHaveBeenCalledWith(step);
  });

  it("dims hidden steps and shows activity while hidden", () => {
    renderMinimap([makeStep({ hidden: true, hasHiddenActivity: true })]);

    expect(
      screen.getByRole("button", { name: "Show step 3 output" })
    ).toHaveClass("opacity-0");
    expect(
      screen
        .getByRole("button", { name: "Show step 3 output" })
        .closest('[role="group"]')
    ).toHaveClass("opacity-60");
    expect(
      document.querySelector("[data-minimap-hidden-activity]")
    ).toBeInTheDocument();
  });
});
