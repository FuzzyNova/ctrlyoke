import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { FINAL_STEP_PHASES } from "@root/types/DashboardConstants";
import {
  OutputMinimap,
  computeDeclutteredTopsPx,
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

function renderMinimap(
  steps: MinimapStep[],
  props: Partial<ComponentProps<typeof OutputMinimap>> = {}
) {
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
      {...props}
    />
  );
}

describe("OutputMinimap step visibility controls", () => {
  it("renders an accessible hide/show control inside each step's popup", () => {
    const onStepClick = vi.fn();
    renderMinimap(
      [makeStep(), makeStep({ key: "queue:3", stepIndex: 3, label: "deploy" })],
      { onStepClick }
    );

    // Only one popup is pinned open at a time — pin each marker in turn and
    // check its own hide/show control renders with the right label.
    fireEvent.click(screen.getByRole("button", { name: "research-db" }));
    expect(
      screen.getByRole("button", { name: "Hide step 3 output" })
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "deploy" }));
    expect(
      screen.getByRole("button", { name: "Hide step 4 output" })
    ).toBeInTheDocument();
  });

  it("toggles a step's visibility through the popup's hide/show control", () => {
    const onStepToggle = vi.fn();
    const onStepClick = vi.fn();
    const step = makeStep();
    renderMinimap([step], { onStepToggle, onStepClick });

    fireEvent.click(screen.getByRole("button", { name: "research-db" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Hide step 3 output" })
    );

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

  it("dims hidden steps, surfaces hidden-but-active state, and labels the popup control Show", () => {
    const onStepClick = vi.fn();
    renderMinimap([makeStep({ hidden: true, hasHiddenActivity: true })], {
      onStepClick,
    });

    expect(
      screen
        .getByRole("button", { name: "research-db" })
        .closest('[role="group"]')
    ).toHaveClass("opacity-60");
    expect(
      document.querySelector("[data-minimap-hidden-activity]")
    ).toBeInTheDocument();
    expect(
      document.querySelector("[data-minimap-hidden-activity]")
    ).toHaveClass("animate-pulse-streaming");

    fireEvent.click(screen.getByRole("button", { name: "research-db" }));
    expect(
      screen.getByRole("button", { name: "Show step 3 output" })
    ).toBeInTheDocument();
  });
});

describe("OutputMinimap marker colors", () => {
  it("does not render an activity band on step markers", () => {
    renderMinimap([makeStep()]);

    expect(
      document.querySelector("[data-minimap-activity-band]")
    ).not.toBeInTheDocument();
  });

  it("keeps pill colors dedicated to undo and redo availability", () => {
    renderMinimap([
      makeStep({ key: "queue:0", label: "selected", selected: true }),
      makeStep({
        key: "queue:1",
        label: "mixed",
        undoActions: {
          undo: { label: "Undo", onTrigger: vi.fn() },
          redo: { label: "Redo", onTrigger: vi.fn() },
        },
      }),
      makeStep({
        key: "queue:2",
        label: "redo",
        undoActions: {
          undo: null,
          redo: { label: "Redo", onTrigger: vi.fn() },
        },
      }),
      makeStep({
        key: "queue:3",
        label: "undo",
        undoActions: {
          undo: { label: "Undo", onTrigger: vi.fn() },
          redo: null,
        },
      }),
    ]);

    expect(screen.getByRole("button", { name: "selected" })).toHaveClass(
      "text-focus-border"
    );
    expect(screen.getByRole("button", { name: "mixed" })).toHaveClass(
      "text-warning-fg"
    );
    expect(screen.getByRole("button", { name: "redo" })).toHaveClass(
      "text-terminal-ansiGreen"
    );
    expect(screen.getByRole("button", { name: "undo" })).toHaveClass(
      "text-link-fg"
    );
  });
});

describe("computeDeclutteredTopsPx", () => {
  it("keeps markers at their raw position when they are already spaced apart", () => {
    const steps = [
      makeStep({ key: "queue:0", scrollFraction: 0.1 }),
      makeStep({ key: "queue:1", scrollFraction: 0.9 }),
    ];

    expect(computeDeclutteredTopsPx(steps, 200)).toEqual([20, 180]);
  });

  it("pushes two close markers apart by at least the pill button's own footprint", () => {
    // Two step anchors landing within a few pixels of each other in
    // scroll-fraction space is the exact condition that let one step's
    // always-in-layout pill button silently steal clicks meant for its
    // neighbor.
    const steps = [
      makeStep({ key: "queue:0", scrollFraction: 0.5 }),
      makeStep({ key: "queue:1", scrollFraction: 0.51 }),
    ];

    const tops = computeDeclutteredTopsPx(steps, 200);
    expect(tops[1] - tops[0]).toBeGreaterThanOrEqual(16);
  });

  it("preserves original step order regardless of scrollFraction order", () => {
    const steps = [
      makeStep({ key: "queue:0", scrollFraction: 0.8 }),
      makeStep({ key: "queue:1", scrollFraction: 0.2 }),
    ];

    const tops = computeDeclutteredTopsPx(steps, 200);
    expect(tops[1]).toBeLessThan(tops[0]);
  });

  it("compresses back within the rail when many close markers would overrun it", () => {
    const steps = Array.from({ length: 5 }, (_, i) =>
      makeStep({ key: `queue:${i}`, scrollFraction: 0.95 + i * 0.001 })
    );

    const tops = computeDeclutteredTopsPx(steps, 60);
    expect(Math.max(...tops)).toBeLessThanOrEqual(57);
    for (let i = 1; i < tops.length; i++) {
      expect(tops[i]).toBeGreaterThan(tops[i - 1]);
    }
  });

  it("returns zeros when the rail has not been measured yet", () => {
    const steps = [makeStep()];
    expect(computeDeclutteredTopsPx(steps, 0)).toEqual([0]);
  });
});
