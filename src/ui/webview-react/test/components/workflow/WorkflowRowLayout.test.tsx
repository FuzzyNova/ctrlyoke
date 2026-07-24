/**
 * Tests for WorkflowRowLayout — the row body shared by the workflow list, the
 * pinned running region, and the run panel.
 */
import { describe, it, expect, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  WorkflowRowLayout,
  RunIndicatorCell,
  composeRowAccessibleName,
  isCompactRow,
} from "@components/workflow/WorkflowRowLayout";
import { WORKFLOW_ROW_TRACKS, type WorkflowRowTier } from "@/constants";
import type { WorkflowRunNavigationSummary } from "@root/types/CtrlYokeTypes";

function renderLayout(
  tier: WorkflowRowTier,
  overrides: Partial<React.ComponentProps<typeof WorkflowRowLayout>> = {}
) {
  return render(
    <WorkflowRowLayout
      tier={tier}
      onClick={vi.fn()}
      ariaLabel="Fix login bug — completed"
      label="Fix login bug"
      count="4 steps"
      badge={<span>COMPLETED</span>}
      time="2 hours ago"
      {...overrides}
    />
  );
}

describe("WorkflowRowLayout", () => {
  it("renders six aligned cells in the flat layout", () => {
    const { container } = renderLayout("flat");
    const button = container.querySelector("button")!;
    expect(button.className).toContain("workflow-row-primary-flat");
    expect(button.querySelector(".col-start-6")?.textContent).toBe(
      "2 hours ago"
    );
  });

  it("moves metadata onto a second line in the stacked layout", () => {
    const { container } = renderLayout("stacked");
    const button = container.querySelector("button")!;
    expect(button.className).toContain("workflow-row-primary-stacked");
    expect(button.querySelector(".workflow-row-cell-label")?.textContent).toBe(
      "Fix login bug"
    );
    expect(button.querySelector(".workflow-row-cell-badge")?.textContent).toBe(
      "COMPLETED"
    );
    expect(button.querySelector(".workflow-row-cell-meta")?.textContent).toBe(
      "4 steps·2 hours ago"
    );
  });

  it("keeps the compact tier stacked rather than inventing a third grid", () => {
    const { container } = renderLayout("compact");
    expect(container.querySelector("button")?.className).toContain(
      "workflow-row-primary-stacked"
    );
  });

  it("omits absent metadata instead of leaving a dangling separator", () => {
    const { container } = renderLayout("stacked", { count: undefined });
    expect(
      container.querySelector(".workflow-row-cell-meta")?.textContent
    ).toBe("2 hours ago");
  });

  it("keeps the accessible name identical across every tier", () => {
    const names = (["flat", "stacked", "compact"] as const).map((tier) =>
      renderLayout(tier)
        .container.querySelector("button")
        ?.getAttribute("aria-label")
    );
    expect(new Set(names).size).toBe(1);
  });

  it("calls onClick from the row's primary button", async () => {
    const onClick = vi.fn();
    renderLayout("stacked", { onClick });
    screen.getByRole("button", { name: /Fix login bug/ }).click();
    expect(onClick).toHaveBeenCalledOnce();
  });
});

describe("isCompactRow", () => {
  it("abbreviates only at the compact tier — stacking alone has room", () => {
    expect(isCompactRow("flat")).toBe(false);
    expect(isCompactRow("stacked")).toBe(false);
    expect(isCompactRow("compact")).toBe(true);
  });
});

describe("RunIndicatorCell", () => {
  const drillable = {
    runCount: 3,
    hasDraft: false,
    primaryRunId: 7,
    primaryAddress: { workflowKey: "wf", kind: "run", runRef: "run-7" },
  } as unknown as WorkflowRunNavigationSummary;
  const singleRun = {
    ...drillable,
    runCount: 1,
  } as WorkflowRunNavigationSummary;

  /** Renders one cell and returns its reserved track element. */
  function renderCell(
    runNav: WorkflowRunNavigationSummary,
    tier: WorkflowRowTier
  ): HTMLSpanElement {
    const { container } = render(
      <RunIndicatorCell
        runNav={runNav}
        workflowName="Fix login bug"
        tier={tier}
        onDrill={vi.fn()}
      />
    );
    return container.querySelector("span")!;
  }

  // Everything to a row's right positions its state badge, so a row that
  // dropped this track (or sized it to its own content) sat its badge tens of
  // pixels out of line with its neighbours — visible as a ragged status
  // column the moment one row in a list had no runs to drill into.
  it.each(["flat", "stacked", "compact"] as const)(
    "reserves the same track for drillable and non-drillable %s rows",
    (tier) => {
      const drillableWidth = renderCell(drillable, tier).style.width;
      const emptyWidth = renderCell(singleRun, tier).style.width;
      expect(drillableWidth).not.toBe("");
      expect(emptyWidth).toBe(drillableWidth);
    }
  );

  it("reserves less once stacked, where the label is the short form", () => {
    expect(renderCell(drillable, "flat").style.width).toBe(
      `${WORKFLOW_ROW_TRACKS.runIndicator.flat}px`
    );
    expect(renderCell(drillable, "compact").style.width).toBe(
      `${WORKFLOW_ROW_TRACKS.runIndicator.stacked}px`
    );
  });

  it("renders no button when there is nothing to drill into", () => {
    renderCell(singleRun, "flat");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("spells out the run in the flat layout and abbreviates when stacked", () => {
    renderCell(drillable, "flat");
    expect(screen.getByRole("button", { name: /Run 7 —/ })).toBeInTheDocument();
    cleanup();
    renderCell(drillable, "stacked");
    expect(screen.getByRole("button", { name: /#7 —/ })).toBeInTheDocument();
  });
});

describe("composeRowAccessibleName", () => {
  it("joins present parts and drops falsy ones", () => {
    expect(
      composeRowAccessibleName([
        "My Workflow",
        "completed",
        false,
        undefined,
        "2 hours ago",
      ])
    ).toBe("My Workflow — completed — 2 hours ago");
  });
});
