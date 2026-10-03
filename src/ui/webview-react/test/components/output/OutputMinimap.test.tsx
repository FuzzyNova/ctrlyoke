import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
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
    changeAction: null,
    changeSummary: null,
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
        changeSummary: {
          total: 2,
          undoable: 1,
          undone: 1,
          blocked: 0,
          label: "View 2 changes (1 undone)",
          compactLabel: "View 2",
          title: "2 files changed · 1 undone, can be redone",
        },
        changeAction: {
          label: "View 2 changes (1 undone)",
          onTrigger: vi.fn(),
        },
      }),
      makeStep({
        key: "queue:2",
        label: "redo",
        changeSummary: {
          total: 1,
          undoable: 0,
          undone: 1,
          blocked: 0,
          label: "View 1 change (all undone)",
          compactLabel: "View 1",
          title: "1 file changed · 1 undone, can be redone",
        },
        changeAction: {
          label: "View 1 change (all undone)",
          onTrigger: vi.fn(),
        },
      }),
      makeStep({
        key: "queue:3",
        label: "undo",
        changeSummary: {
          total: 1,
          undoable: 1,
          undone: 0,
          blocked: 0,
          label: "View 1 change",
          compactLabel: "View 1",
          title: "1 file changed",
        },
        changeAction: { label: "View 1 change", onTrigger: vi.fn() },
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

describe("OutputMinimap diff bars", () => {
  it("renders the quantized flat bar shape at the measured rail height", () => {
    const clientHeight = vi
      .spyOn(HTMLElement.prototype, "clientHeight", "get")
      .mockReturnValue(10);

    try {
      renderMinimap([
        makeStep({
          diffBlocks: [
            {
              key: "diff-1",
              rowKey: "row-1",
              scrollFraction: 0.2,
              heightFraction: 0.5,
              addedLines: 5,
              removedLines: 0,
              runs: [],
              isCollapsed: false,
            },
          ],
        }),
      ]);

      const bars = document.querySelectorAll("[data-minimap-diff-bar]");
      expect(bars).toHaveLength(5);
      expect(bars[0]).toHaveStyle({ top: "2px", height: "1px" });
      expect(bars[4]).toHaveStyle({ top: "6px", height: "1px" });
      expect(
        document.querySelectorAll("[data-minimap-diff-bar] > div")
      ).toHaveLength(0);
    } finally {
      clientHeight.mockRestore();
    }
  });

  it("fills the whole band a merged run spans", () => {
    const clientHeight = vi
      .spyOn(HTMLElement.prototype, "clientHeight", "get")
      .mockReturnValue(10);

    try {
      renderMinimap([
        makeStep({
          diffBlocks: [
            {
              key: "diff-run",
              rowKey: "row-run",
              scrollFraction: 0.2,
              heightFraction: 0.5,
              addedLines: 20,
              removedLines: 0,
              // One merged run of 20 identical insertion rows — `addedLines`
              // is per row, so this must paint all five rail pixels the block
              // covers, not the single pixel one "added line" would buy.
              runs: [{ count: 20, addedLines: 1, removedLines: 0 }],
              isCollapsed: false,
            },
          ],
        }),
      ]);

      const bars = document.querySelectorAll("[data-minimap-diff-bar]");
      expect(bars).toHaveLength(5);
      expect(bars[0]).toHaveStyle({
        top: "2px",
        background: "var(--cy-minimap-diff-added)",
      });
      expect(bars[4]).toHaveStyle({
        top: "6px",
        background: "var(--cy-minimap-diff-added)",
      });
    } finally {
      clientHeight.mockRestore();
    }
  });

  it("renders a solid color when two solo runs share a bar, and a split only for a genuinely paired run", () => {
    const clientHeight = vi
      .spyOn(HTMLElement.prototype, "clientHeight", "get")
      .mockReturnValue(1);

    try {
      // Unrelated solo added-only and removed-only runs quantized onto the
      // same single-pixel rail — must stay solid (last-write-wins in the old
      // per-run rendering), never a red/green blend.
      const { unmount } = renderMinimap([
        makeStep({
          diffBlocks: [
            {
              key: "diff-solo",
              rowKey: "row-solo",
              scrollFraction: 0,
              heightFraction: 1,
              addedLines: 1,
              removedLines: 1,
              runs: [
                { count: 1, addedLines: 1, removedLines: 0 },
                { count: 1, addedLines: 0, removedLines: 1 },
              ],
              isCollapsed: false,
            },
          ],
        }),
      ]);

      const soloBar = document.querySelector("[data-minimap-diff-bar]");
      expect(soloBar).not.toBeNull();
      expect(soloBar).toHaveStyle({
        background: "var(--cy-minimap-diff-removed)",
      });
      unmount();

      // A single split-view paired delete+insert run is genuinely mixed and
      // should render as a red/green split.
      renderMinimap([
        makeStep({
          diffBlocks: [
            {
              key: "diff-paired",
              rowKey: "row-paired",
              scrollFraction: 0,
              heightFraction: 1,
              addedLines: 1,
              removedLines: 1,
              runs: [{ count: 1, addedLines: 1, removedLines: 1 }],
              isCollapsed: false,
            },
          ],
        }),
      ]);

      const pairedBar = document.querySelector("[data-minimap-diff-bar]");
      expect(pairedBar?.getAttribute("style")).toContain("linear-gradient");
    } finally {
      clientHeight.mockRestore();
    }
  });
});

describe("OutputMinimap grouped markers", () => {
  function renderOnMeasuredRail(
    steps: MinimapStep[],
    props: Partial<ComponentProps<typeof OutputMinimap>> = {}
  ) {
    const clientHeight = vi
      .spyOn(HTMLElement.prototype, "clientHeight", "get")
      .mockReturnValue(200);
    const result = renderMinimap(steps, props);
    return { ...result, restore: () => clientHeight.mockRestore() };
  }

  const closeSteps = () => [
    makeStep({
      key: "queue:2",
      stepIndex: 2,
      label: "plan",
      scrollFraction: 0.5,
    }),
    makeStep({
      key: "queue:3",
      stepIndex: 3,
      label: "build",
      scrollFraction: 0.505,
    }),
  ];

  it("mounts a marker's popup only while it is hovered or pinned", () => {
    const { restore } = renderOnMeasuredRail([makeStep()]);
    try {
      expect(
        screen.queryByRole("button", { name: "Hide step 3 output" })
      ).not.toBeInTheDocument();

      const group = screen.getByRole("group", { name: "Step research-db" });
      fireEvent.mouseEnter(group);
      expect(
        screen.getByRole("button", { name: "Hide step 3 output" })
      ).toBeInTheDocument();

      fireEvent.mouseLeave(group);
      expect(
        screen.queryByRole("button", { name: "Hide step 3 output" })
      ).not.toBeInTheDocument();
    } finally {
      restore();
    }
  });

  it("shares one marker between steps too close to tell apart, with one popup row each", () => {
    const onStepClick = vi.fn();
    const onStepToggle = vi.fn();
    const steps = closeSteps();
    const { restore } = renderOnMeasuredRail(steps, {
      onStepClick,
      onStepToggle,
    });
    try {
      const marker = screen.getByRole("button", {
        name: "2 steps: plan – build",
      });
      expect(screen.queryByRole("button", { name: "plan" })).toBeNull();

      fireEvent.click(marker);
      // The marker itself jumps to the group's first step.
      expect(onStepClick).toHaveBeenCalledWith(steps[0]);
      expect(screen.getByText("2 steps")).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Go to build" }));
      expect(onStepClick).toHaveBeenLastCalledWith(steps[1]);

      fireEvent.click(
        screen.getByRole("button", { name: "Hide step 4 output" })
      );
      expect(onStepToggle).toHaveBeenCalledWith(steps[1]);
    } finally {
      restore();
    }
  });

  it("solos one member from its popup row on Alt-click", () => {
    const onStepSolo = vi.fn();
    const steps = closeSteps();
    const { restore } = renderOnMeasuredRail(steps, {
      onStepSolo,
      onStepClick: vi.fn(),
    });
    try {
      fireEvent.click(
        screen.getByRole("button", { name: "2 steps: plan – build" })
      );
      fireEvent.click(screen.getByRole("button", { name: "Go to plan" }), {
        altKey: true,
      });
      expect(onStepSolo).toHaveBeenCalledWith(steps[0]);
    } finally {
      restore();
    }
  });

  it("colors a grouped marker by its most important member and dims it only when all are hidden", () => {
    const [plan, build] = closeSteps();
    const { restore } = renderOnMeasuredRail([
      { ...plan, hidden: true },
      { ...build, selected: true },
    ]);
    try {
      const marker = screen.getByRole("button", {
        name: "2 steps: plan – build",
      });
      expect(marker).toHaveClass("text-focus-border");
      expect(marker.closest('[role="group"]')).not.toHaveClass("opacity-60");
    } finally {
      restore();
    }
  });

  it("keeps every marker of a long run on the rail", () => {
    const steps = Array.from({ length: 400 }, (_, i) =>
      makeStep({
        key: `queue:${i}`,
        stepIndex: i,
        label: `step-${i}`,
        scrollFraction: i / 400,
      })
    );
    const { restore } = renderOnMeasuredRail(steps);
    try {
      const groups = screen.getAllByRole("group");
      expect(groups.length).toBeLessThan(400);
      for (const group of groups) {
        const top = parseFloat(group.style.top);
        const height = parseFloat(group.style.height);
        expect(top).toBeGreaterThanOrEqual(0);
        expect(top + height).toBeLessThanOrEqual(200);
      }
    } finally {
      restore();
    }
  });
});
