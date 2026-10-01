import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  CollapsibleOutputSection,
  OutputTogglePinContext,
  collapsibleOutputSectionSelector,
  getEnclosingCollapsibleOutputSection,
} from "@components/output/CollapsibleOutputSection";

function renderSection(
  overrides: Partial<React.ComponentProps<typeof CollapsibleOutputSection>> = {}
) {
  const onToggle = vi.fn();
  const pinToggle = vi.fn();
  const view = render(
    <OutputTogglePinContext.Provider value={pinToggle}>
      <CollapsibleOutputSection
        section="output"
        contentId="section-output"
        noun="output"
        visibleText={"line 1\nline 2"}
        canToggle
        isExpanded={false}
        isTruncated
        hiddenLineCount={8}
        onToggle={onToggle}
        {...overrides}
      />
    </OutputTogglePinContext.Provider>
  );
  return { ...view, onToggle, pinToggle };
}

describe("CollapsibleOutputSection", () => {
  it("pins the clicked toggle before toggling", async () => {
    const user = userEvent.setup();
    const { onToggle, pinToggle } = renderSection();
    const toggle = screen.getByRole("button", { name: "Show full output" });

    await user.click(toggle);

    expect(pinToggle).toHaveBeenCalledWith(toggle);
    expect(onToggle).toHaveBeenCalledWith(true);
    expect(pinToggle.mock.invocationCallOrder[0]).toBeLessThan(
      onToggle.mock.invocationCallOrder[0]
    );
  });

  it("sticks the toggle only while expanded, below any pinned banner", () => {
    const { rerender, onToggle, pinToggle } = renderSection();
    expect(
      screen.getByRole("button", { name: "Show full output" }).className
    ).not.toContain("sticky");

    rerender(
      <OutputTogglePinContext.Provider value={pinToggle}>
        <CollapsibleOutputSection
          section="output"
          contentId="section-output"
          noun="output"
          visibleText={"line 1\nline 2"}
          canToggle
          isExpanded
          isTruncated={false}
          hiddenLineCount={0}
          onToggle={onToggle}
        />
      </OutputTogglePinContext.Provider>
    );
    const hide = screen.getByRole("button", { name: "Hide full output" });
    expect(hide.className).toContain("sticky");
    expect(hide.className).toContain("top-[var(--cy-output-sticky-top,0px)]");
    expect(hide).toHaveAttribute("aria-controls", "section-output");
    expect(screen.queryByText(/more lines/)).not.toBeInTheDocument();
  });

  it("renders the hidden-lines notice as text, not a control", () => {
    renderSection();
    const notice = screen.getByText(
      "… 8 more lines (click Show full output to view)"
    );
    expect(notice.closest("button")).toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("renders no toggle or notice when nothing is hidden", () => {
    renderSection({ canToggle: false, isTruncated: false, hiddenLineCount: 0 });
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByText(/more lines/)).not.toBeInTheDocument();
  });

  it("lets the pane find the section from its toggle and by name", () => {
    const { container } = renderSection({ section: "error", noun: "error" });
    const toggle = screen.getByRole("button", { name: "Show full error" });
    expect(getEnclosingCollapsibleOutputSection(toggle)).toBe("error");
    expect(
      container.querySelector(collapsibleOutputSectionSelector("error"))
    ).toBe(toggle.parentElement);
  });
});
