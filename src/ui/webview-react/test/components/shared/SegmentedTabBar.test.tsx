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
});
