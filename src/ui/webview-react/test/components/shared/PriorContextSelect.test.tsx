import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PriorContextSelect } from "@components/shared/PriorContextSelect";

describe("PriorContextSelect schema metadata", () => {
  it("uses the shared keyword labels and property details", () => {
    render(
      <PriorContextSelect
        value="previous"
        onChange={vi.fn()}
        showDefault
        defaultLabel="Inherit (All prior steps)"
        schemaPath="priorContext"
      />
    );

    const trigger = screen.getByRole("button", { name: "Previous, priorContext: previous" });
    expect(trigger).toHaveAttribute("title", expect.stringContaining("property: priorContext = previous"));
    fireEvent.click(trigger);
    expect(screen.getByRole("button", { name: "All, priorContext: all" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Inherit (All prior steps), omit priorContext" })).toBeInTheDocument();
  });

  it("shows the YAML shapes for the run and custom pseudo-options", () => {
    render(<PriorContextSelect value={undefined} onChange={vi.fn()} showDefault />);
    fireEvent.click(screen.getByRole("button", { name: /Inherit/ }));
    expect(screen.getByRole("button", { name: /Completed run output.*priorContext: \{ workflowKey/ })).toHaveAttribute("title", expect.stringContaining("priorContext: { workflowKey: ..., runRef: ... }"));
    expect(screen.getByRole("button", { name: /Custom.*priorContext: \[1,2\]/ })).toHaveAttribute("title", expect.stringContaining("priorContext: [1,2]"));
  });
});
