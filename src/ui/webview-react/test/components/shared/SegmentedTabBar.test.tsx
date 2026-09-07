import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  SegmentedTabBar,
  type SegmentedTab,
} from "@components/shared/SegmentedTabBar";

type TestTabId = "summary" | "details";

const tabs = [
  { id: "summary", label: "Summary", codicon: "book" },
  { id: "details", label: "Details", codicon: "info" },
] satisfies readonly SegmentedTab<TestTabId>[];

describe("SegmentedTabBar", () => {
  it("selects a tab through the typed callback", async () => {
    const user = userEvent.setup();
    const onTabChange = vi.fn();

    render(
      <SegmentedTabBar
        tabs={tabs}
        activeTab="summary"
        onTabChange={onTabChange}
        ariaLabel="Test properties"
      />
    );

    await user.click(screen.getByRole("tab", { name: "Details" }));

    expect(onTabChange).toHaveBeenCalledWith("details");
  });

  it("names each tab for role-based queries", () => {
    render(
      <SegmentedTabBar
        tabs={tabs}
        activeTab="summary"
        onTabChange={vi.fn()}
        ariaLabel="Test properties"
      />
    );

    expect(
      screen.getByRole("tablist", { name: "Test properties" })
    ).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Summary" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(screen.getByRole("tab", { name: "Details" })).toHaveAttribute(
      "aria-selected",
      "false"
    );
  });

  it("applies icon overrides to inactive tabs", () => {
    render(
      <SegmentedTabBar
        tabs={tabs}
        activeTab="summary"
        onTabChange={vi.fn()}
        ariaLabel="Test properties"
        tabOverrides={{
          details: {
            codicon: "warning",
            color: "text-warning-fg",
            hoverColor: "hover:text-terminal-ansiBrightYellow",
          },
        }}
      />
    );

    const details = screen.getByRole("tab", { name: "Details" });
    expect(details).toHaveClass("text-warning-fg");
    expect(details).toHaveClass("hover:text-terminal-ansiBrightYellow");
    expect(details.querySelector(".codicon")).toHaveClass("codicon-warning");
  });

  it("marks the active tab with the active underline and color", () => {
    render(
      <SegmentedTabBar
        tabs={tabs}
        activeTab="summary"
        onTabChange={vi.fn()}
        ariaLabel="Test properties"
        tabOverrides={{
          summary: { activeColor: "text-focus-highlight" },
        }}
      />
    );

    const summary = screen.getByRole("tab", { name: "Summary" });
    const details = screen.getByRole("tab", { name: "Details" });
    expect(summary).toHaveAttribute("aria-selected", "true");
    expect(details).toHaveAttribute("aria-selected", "false");
  });

  it("renders a distinct corner badge for active and inactive tabs", () => {
    render(
      <SegmentedTabBar
        tabs={tabs}
        activeTab="summary"
        onTabChange={vi.fn()}
        ariaLabel="Test properties"
        tabOverrides={{
          summary: { badgeCodicon: "shield", badgeColor: "text-error-fg" },
          details: { badgeCodicon: "warning", badgeColor: "text-warning-fg" },
        }}
      />
    );

    const summaryBadge = screen
      .getByRole("tab", { name: "Summary" })
      .querySelector(".codicon-shield");
    const detailsBadge = screen
      .getByRole("tab", { name: "Details" })
      .querySelector(".codicon-warning");

    expect(summaryBadge).toHaveStyle({ fontSize: "11px" });
    expect(detailsBadge).toHaveStyle({ fontSize: "11px" });
    expect(summaryBadge?.parentElement).toHaveClass(
      "absolute",
      "bg-sidebar-bg"
    );
    expect(detailsBadge?.parentElement).toHaveClass(
      "absolute",
      "bg-sidebar-bg"
    );
    expect(summaryBadge?.parentElement).toHaveAttribute("aria-hidden", "true");
    expect(detailsBadge?.parentElement).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByRole("tab", { name: "Summary" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(screen.getByRole("tab", { name: "Details" })).toHaveAttribute(
      "aria-selected",
      "false"
    );
  });

  it("does not render a badge when the override omits one", () => {
    render(
      <SegmentedTabBar
        tabs={tabs}
        activeTab="summary"
        onTabChange={vi.fn()}
        ariaLabel="Test properties"
        tabOverrides={{ summary: { color: "text-error-fg" } }}
      />
    );

    expect(
      screen.getByRole("tab", { name: "Summary" }).querySelector(".absolute")
    ).toBeNull();
  });
});
