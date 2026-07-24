/**
 * Tests for WorkflowRowLayout — the row body shared by the workflow list, the
 * pinned running region, and the run panel.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  WorkflowRowLayout,
  composeRowAccessibleName,
} from "@components/workflow/WorkflowRowLayout";

function renderLayout(
  isStacked: boolean,
  overrides: Partial<React.ComponentProps<typeof WorkflowRowLayout>> = {}
) {
  return render(
    <WorkflowRowLayout
      isStacked={isStacked}
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
    const { container } = renderLayout(false);
    const button = container.querySelector("button")!;
    expect(button.className).toContain("workflow-row-primary-flat");
    expect(button.querySelector(".col-start-6")?.textContent).toBe(
      "2 hours ago"
    );
  });

  it("moves metadata onto a second line in the stacked layout", () => {
    const { container } = renderLayout(true);
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

  it("omits absent metadata instead of leaving a dangling separator", () => {
    const { container } = renderLayout(true, { count: undefined });
    expect(
      container.querySelector(".workflow-row-cell-meta")?.textContent
    ).toBe("2 hours ago");
  });

  it("keeps the accessible name identical across both layouts", () => {
    const { container: flat } = renderLayout(false);
    const { container: stacked } = renderLayout(true);
    expect(flat.querySelector("button")?.getAttribute("aria-label")).toBe(
      stacked.querySelector("button")?.getAttribute("aria-label")
    );
  });

  it("calls onClick from the row's primary button", async () => {
    const onClick = vi.fn();
    renderLayout(true, { onClick });
    screen.getByRole("button", { name: /Fix login bug/ }).click();
    expect(onClick).toHaveBeenCalledOnce();
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
