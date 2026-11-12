/**
 * Tests for WorkflowRowLayout — the row body shared by the workflow list, the
 * pinned running region, and the run panel.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  WorkflowRowLayout,
  RunIndicatorCell,
  RowActionButton,
  ScheduleRowActionButton,
  ROW_ACTION_BUTTON_CLASS,
  composeRowAccessibleName,
  isCompactRow,
} from "@components/workflow/WorkflowRowLayout";
import { WORKFLOW_ROW_TRACKS, type WorkflowRowTier } from "@/constants";
import type { WorkflowRunNavigationSummary } from "@root/types/CtrlYokeTypes";
import { WORKFLOW_VIEW_ADDRESS_KIND } from "@root/types/DashboardConstants";
import { Icon } from "../../../components/shared/Icon";

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
    expect(button.className).toContain("workflow-row-primary");
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

  it.each(["stacked", "compact"] as const)(
    "puts usage and run time on their own third line at the %s tier",
    (tier) => {
      const { container } = renderLayout(tier, {
        usage: "410k",
        duration: "8:51",
      });
      expect(
        container.querySelector(".workflow-row-cell-meta-activity")?.textContent
      ).toBe("4 steps·2 hours ago");
      expect(
        container.querySelector(".workflow-row-cell-meta-usage")?.textContent
      ).toBe("410k·8:51");
    }
  );

  it("renders an empty usage line so every row keeps the same height", () => {
    const { container } = renderLayout("stacked");
    const usageLine = container.querySelector(".workflow-row-cell-meta-usage");
    expect(usageLine).not.toBeNull();
    expect(usageLine?.textContent).toBe("");
  });

  it("reserves the widest state's width for a full-text badge only", () => {
    const badgeCell = (tier: WorkflowRowTier) =>
      renderLayout(tier).container.querySelector<HTMLElement>(
        ".workflow-row-cell-badge"
      )!;
    expect(badgeCell("stacked").style.minWidth).toBe(
      `${WORKFLOW_ROW_TRACKS.state}px`
    );
    expect(badgeCell("compact").style.minWidth).toBe("");
  });

  // At compact the rail reaches into the run-nav column beside the icon-only
  // badge (so the run indicator stays flush against the badge); the
  // metadata lines must stop short of it.
  it("marks only the compact tier so its metadata stops before the rail", () => {
    const primary = (tier: WorkflowRowTier) =>
      renderLayout(tier).container.querySelector("button")!;
    expect(primary("compact")).toHaveClass("workflow-row-primary-compact");
    expect(primary("stacked")).not.toHaveClass("workflow-row-primary-compact");
  });

  it("keeps the compact tier on the same grid, not a third layout", () => {
    const { container } = renderLayout("compact");
    expect(container.querySelector("button")?.className).toContain(
      "workflow-row-primary"
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
      glyph: <Icon name="terminal" />,
      worktree: {
        branchName: "feature/auth",
        worktreePath: "C:/worktrees/feature-auth",
      },
    });

    const meta = container.querySelector(".workflow-row-cell-meta")!;
    const icons = meta.querySelectorAll(".codicon");
    expect(icons).toHaveLength(2);
    expect(icons[0]).toHaveClass("codicon-terminal");
    expect(icons[1]).toHaveClass("codicon-worktree-compact");
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
    primaryAddress: {
      workflowKey: "wf",
      kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
      runRef: "run-7",
    },
  } as unknown as WorkflowRunNavigationSummary;
  const singleRun = {
    ...drillable,
    runCount: 1,
  } as WorkflowRunNavigationSummary;

  /** Renders one cell and returns its outer element, if it rendered one. */
  function renderCell(runNav: WorkflowRunNavigationSummary): Element | null {
    const { container } = render(
      <RunIndicatorCell
        runNav={runNav}
        workflowName="Fix login bug"
        onDrill={vi.fn()}
      />
    );
    return container.firstElementChild;
  }

  it("carries the class that places it on the first line beside the badge", () => {
    expect(renderCell(drillable)).toHaveClass("workflow-row-run-nav");
  });

  // The row's name takes the run-nav column when no indicator is rendered
  // (`.workflow-row:not(:has(> .workflow-row-run-nav))`), so an empty
  // placeholder would hold that space for nothing.
  it("renders nothing at all when there is nothing to drill into", () => {
    expect(renderCell(singleRun)).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("sizes to its content instead of reserving a fixed track", () => {
    expect((renderCell(drillable) as HTMLElement).style.width).toBe("");
  });

  it("abbreviates the run to its short form", () => {
    renderCell(drillable);
    expect(screen.getByRole("button", { name: /#7 —/ })).toBeInTheDocument();
  });

  it("uses an explicit height and zero vertical padding to center its contents", () => {
    renderCell(drillable);

    const button = screen.getByRole("button", { name: /#7 —/ });
    expect(button).toHaveClass("h-5", "items-center", "py-0", "leading-none");
    expect(button.querySelector(".codicon")).toHaveClass(
      "block",
      "leading-none"
    );
  });
});

describe("row action buttons", () => {
  // The schedule button once missed the hover background its neighbours had;
  // every rail button now takes shape and hover from one class.
  it.each([
    ["never scheduled", undefined],
    ["scheduled", { enabled: true }],
    ["paused", { enabled: false }],
  ] as const)(
    "gives the %s schedule button the shared shape and hover background",
    (_state, schedule) => {
      render(
        <ScheduleRowActionButton
          schedule={schedule as never}
          scheduleNextRunAt={undefined}
          onOpen={vi.fn()}
        />
      );
      expect(screen.getByRole("button")).toHaveClass(
        ...ROW_ACTION_BUTTON_CLASS.split(" ")
      );
    }
  );

  it("is a 30px box with a hover background", () => {
    expect(ROW_ACTION_BUTTON_CLASS).toContain("h-[30px]");
    expect(ROW_ACTION_BUTTON_CLASS).toContain("w-[30px]");
    expect(ROW_ACTION_BUTTON_CLASS).toContain("hover:bg-toolbar-hover-bg");
  });

  it("hands the button to onClick as the opener without clicking the row", () => {
    const onClick = vi.fn();
    const onRowClick = vi.fn();
    render(
      // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- test harness standing in for the row
      <div onClick={onRowClick}>
        <RowActionButton
          icon="trash"
          title="Remove from history"
          onClick={onClick}
          toneClassName="text-description-fg"
        />
      </div>
    );
    const button = screen.getByRole("button", { name: "Remove from history" });
    button.click();
    expect(onClick).toHaveBeenCalledWith(button);
    expect(onRowClick).not.toHaveBeenCalled();
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
