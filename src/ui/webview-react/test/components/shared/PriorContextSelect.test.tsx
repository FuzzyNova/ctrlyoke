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

    const trigger = screen.getByRole("button", {
      name: "Previous, priorContext: previous",
    });
    expect(trigger).toHaveAttribute(
      "title",
      expect.stringContaining("property: priorContext = previous")
    );
    fireEvent.click(trigger);
    expect(
      screen.getByRole("button", { name: "All, priorContext: all" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Inherit (All prior steps), omit priorContext",
      })
    ).toBeInTheDocument();
  });

  it("shows the YAML shapes for the run and custom pseudo-options", () => {
    render(
      <PriorContextSelect value={undefined} onChange={vi.fn()} showDefault />
    );
    fireEvent.click(screen.getByRole("button", { name: /Inherit/ }));
    expect(
      screen.getByRole("button", {
        name: /Completed run output.*priorContext: \{ workflowKey/,
      })
    ).toHaveAttribute(
      "title",
      expect.stringContaining("priorContext: { workflowKey: ..., runRef: ... }")
    );
    expect(
      screen.getByRole("button", { name: /Custom.*priorContext: \[1,2\]/ })
    ).toHaveAttribute("title", expect.stringContaining("priorContext: [1,2]"));
  });

  it("selects Previous N as a relative { previous } value", () => {
    const onChange = vi.fn();
    render(<PriorContextSelect value="none" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /None/ }));
    fireEvent.click(
      screen.getByRole("button", {
        name: /Previous N.*priorContext: \{ previous: 3 \}/,
      })
    );
    expect(onChange).toHaveBeenLastCalledWith({ previous: 3 });
  });

  it("shows the count and writes edits back", () => {
    const onChange = vi.fn();
    render(<PriorContextSelect value={{ previous: 4 }} onChange={onChange} />);
    expect(
      screen.getByRole("button", { name: /^Previous 4,/ })
    ).toBeInTheDocument();
    const input = screen.getByLabelText("Number of previous step outputs");
    expect(input).toHaveValue("4");

    fireEvent.change(input, { target: { value: "6" } });
    expect(onChange).toHaveBeenLastCalledWith({ previous: 6 });

    onChange.mockClear();
    fireEvent.change(input, { target: { value: "0" } });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not treat { previous } as a run address", () => {
    render(<PriorContextSelect value={{ previous: 2 }} onChange={vi.fn()} />);
    expect(
      screen.queryByLabelText("Prior-context workflow key")
    ).not.toBeInTheDocument();
  });
});
