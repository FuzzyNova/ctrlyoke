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
      />
    );

    await user.click(screen.getByTitle("Details"));

    expect(onTabChange).toHaveBeenCalledWith("details");
  });

  it("applies icon overrides to inactive tabs", () => {
    render(
      <SegmentedTabBar
        tabs={tabs}
        activeTab="summary"
        onTabChange={vi.fn()}
        tabOverrides={{
          details: {
            codicon: "warning",
            color: "text-warning-fg",
            hoverColor: "hover:text-terminal-ansiBrightYellow",
          },
        }}
      />
    );

    const details = screen.getByTitle("Details");
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
        tabOverrides={{
          summary: { activeColor: "text-focus-highlight" },
        }}
      />
    );

    const summary = screen.getByTitle("Summary");
    expect(summary).toHaveClass("fp-tab-hc-selected");
    expect(summary).toHaveClass("border-b-focus-border");
    expect(summary).toHaveClass("text-focus-highlight");
    expect(summary).not.toHaveClass("text-description-fg");
  });

  it("renders a distinct corner badge for active and inactive tabs", () => {
    render(
      <SegmentedTabBar
        tabs={tabs}
        activeTab="summary"
        onTabChange={vi.fn()}
        tabOverrides={{
          summary: { badgeCodicon: "shield", badgeColor: "text-error-fg" },
          details: { badgeCodicon: "warning", badgeColor: "text-warning-fg" },
        }}
      />
    );

    const summaryBadge = screen
      .getByTitle("Summary")
      .querySelector(".codicon-shield");
    const detailsBadge = screen
      .getByTitle("Details")
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
    expect(screen.getByTitle("Summary")).toHaveAttribute("title", "Summary");
    expect(screen.getByTitle("Details")).toHaveAttribute("title", "Details");
  });

  it("does not render a badge when the override omits one", () => {
    render(
      <SegmentedTabBar
        tabs={tabs}
        activeTab="summary"
        onTabChange={vi.fn()}
        tabOverrides={{ summary: { color: "text-error-fg" } }}
      />
    );

    expect(screen.getByTitle("Summary").querySelector(".absolute")).toBeNull();
  });
});
