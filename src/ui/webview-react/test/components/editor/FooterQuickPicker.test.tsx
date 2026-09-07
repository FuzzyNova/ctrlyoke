import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { FooterQuickPicker } from "@components/editor/FooterQuickPicker";

describe("FooterQuickPicker", () => {
  it("names the trigger while retaining its title tooltip", () => {
    render(
      <FooterQuickPicker
        isNarrow={true}
        showLabel={false}
        icon={<span>i</span>}
        valueLabel="Value"
        isOverride={false}
        isOpen={false}
        onToggle={vi.fn()}
        onClose={vi.fn()}
        title="Model override"
      >
        <div>Picker content</div>
      </FooterQuickPicker>
    );

    const trigger = screen.getByRole("button", { name: "Model override" });
    expect(trigger).toHaveAttribute("title", "Model override");
  });

  it("renders the popup heading above the inline picker content", async () => {
    render(
      <FooterQuickPicker
        isNarrow={false}
        showLabel={true}
        icon={<span>i</span>}
        valueLabel="Value"
        isOverride={false}
        isOpen={true}
        onToggle={vi.fn()}
        onClose={vi.fn()}
        title="Picker"
        heading="Harness"
      >
        <div>Picker content</div>
      </FooterQuickPicker>
    );

    expect(screen.getByText("Harness")).toBeInTheDocument();
    expect(screen.getByText("Picker content")).toBeInTheDocument();
  });
});
