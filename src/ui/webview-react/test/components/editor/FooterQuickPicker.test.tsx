import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { FooterQuickPicker } from "@components/editor/FooterQuickPicker";

describe("FooterQuickPicker", () => {
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
