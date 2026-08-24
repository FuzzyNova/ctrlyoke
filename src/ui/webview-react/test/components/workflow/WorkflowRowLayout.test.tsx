/**
 * Tests for WorkflowRowLayout — the row body shared by the workflow list, the
 * pinned running region, and the run panel.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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
  it("renders the name on its own line with metadata on a second, muted line", () => {
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

  it("keeps the compact tier on the same grid, not a third layout", () => {
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
    const names = (["stacked", "compact"] as const).map((tier) =>
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

  it("renders the worktree icon beside the row glyph with branch and location tooltip", () => {
    const { container } = renderLayout("stacked", {
      glyph: <i className="codicon codicon-terminal" />,
      worktree: {
        branchName: "feature/auth",
        worktreePath: "C:/worktrees/feature-auth",
      },
    });

    const meta = container.querySelector(".workflow-row-cell-meta")!;
    const icons = meta.querySelectorAll(".codicon");
    expect(icons).toHaveLength(2);
    expect(icons[0]).toHaveClass("codicon-terminal");
    expect(icons[1]).toHaveClass("codicon-source-control");
    expect(icons[1]).toHaveAttribute(
      "title",
      "Branch: feature/auth\nWorktree: C:/worktrees/feature-auth"
    );
  });
});

describe("isCompactRow", () => {
  it("abbreviates only at the compact tier", () => {
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
  function renderCell(runNav: WorkflowRunNavigationSummary): HTMLSpanElement {
    const { container } = render(
      <RunIndicatorCell
        runNav={runNav}
        workflowName="Fix login bug"
        onDrill={vi.fn()}
      />
    );
    return container.querySelector("span")!;
  }

  // Everything to a row's right positions its state badge, so a row that
  // dropped this track (or sized it to its own content) sat its badge tens of
  // pixels out of line with its neighbours — visible as a ragged status
  // column the moment one row in a list had no runs to drill into.
  it("reserves the same track for drillable and non-drillable rows", () => {
    const drillableWidth = renderCell(drillable).style.width;
    const emptyWidth = renderCell(singleRun).style.width;
    expect(drillableWidth).not.toBe("");
    expect(emptyWidth).toBe(drillableWidth);
  });

  it("reserves WORKFLOW_ROW_TRACKS.runIndicator", () => {
    expect(renderCell(drillable).style.width).toBe(
      `${WORKFLOW_ROW_TRACKS.runIndicator}px`
    );
  });

  it("renders no button when there is nothing to drill into", () => {
    renderCell(singleRun);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("abbreviates the run to its short form", () => {
    renderCell(drillable);
    expect(screen.getByRole("button", { name: /#7 —/ })).toBeInTheDocument();
  });

  it("uses an explicit height and zero vertical padding to center its contents", () => {
    renderCell(drillable);

    const button = screen.getByRole("button", { name: /#7 —/ });
    expect(button).toHaveClass("h-8", "items-center", "py-0", "leading-none");
    expect(button.querySelector(".codicon")).toHaveClass(
      "block",
      "leading-none"
    );
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
