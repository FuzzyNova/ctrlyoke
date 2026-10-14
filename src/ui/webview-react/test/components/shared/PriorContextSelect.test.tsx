import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PriorContextSelect } from "@components/shared/PriorContextSelect";

describe("PriorContextSelect schema metadata", () => {
  it("shows the detail dropdown after the kind and binds it", () => {
    const onDetailChange = vi.fn();
    render(
      <PriorContextSelect
        id="prior-context"
        value="previous"
        onChange={vi.fn()}
        detail="summary"
        detailId="prior-context-detail"
        onDetailChange={onDetailChange}
      />
    );

    const kind = document.getElementById("prior-context")!;
    const detail = document.getElementById("prior-context-detail")!;
    expect(kind).toHaveTextContent("Previous step");
    expect(kind).not.toHaveTextContent("summary");
    expect(detail).toHaveTextContent("Summary");
    expect(
      kind.compareDocumentPosition(detail) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();

    fireEvent.click(detail);
    expect(
      screen.queryByRole("button", { name: /Inherit/ })
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Full/ }));
    expect(onDetailChange).toHaveBeenCalledWith("full");
  });

  it("offers an inherit detail and disables detail for none", () => {
    const onDetailChange = vi.fn();
    const { rerender } = render(
      <PriorContextSelect
        value="previous"
        onChange={vi.fn()}
        detailId="prior-context-detail"
        detailInheritLabel="Inherit (Summary)"
        onDetailChange={onDetailChange}
      />
    );

    const detail = document.getElementById("prior-context-detail")!;
    expect(detail).toHaveTextContent("Inherit (Summary)");
    fireEvent.click(detail);
    fireEvent.click(screen.getByRole("button", { name: /^Full/ }));
    expect(onDetailChange).toHaveBeenLastCalledWith("full");

    rerender(
      <PriorContextSelect
        value="none"
        onChange={vi.fn()}
        detailId="prior-context-detail"
        detailInheritLabel="Inherit (Summary)"
        onDetailChange={onDetailChange}
      />
    );
    expect(document.getElementById("prior-context-detail")).toBeDisabled();
  });

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
      name: "Previous step, priorContext: previous",
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
        name: /Completed run output.*priorContext: \{ workflow:/,
      })
    ).toHaveAttribute(
      "title",
      expect.stringContaining("priorContext: { workflow: ..., run: ... }")
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

  it("shows the custom range input only while Custom is selected", () => {
    render(<PriorContextSelect value={{ previous: 2 }} onChange={vi.fn()} />);
    expect(
      screen.queryByLabelText(/Custom step range/)
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Previous 2,/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Custom/ }));
    expect(screen.getByLabelText(/Custom step range/)).toBeInTheDocument();
    expect(
      screen.queryByLabelText("Number of previous step outputs")
    ).not.toBeInTheDocument();
  });

  it("does not treat { previous } as a run source", () => {
    render(<PriorContextSelect value={{ previous: 2 }} onChange={vi.fn()} />);
    expect(
      screen.queryByLabelText("Prior-context workflow")
    ).not.toBeInTheDocument();
  });

  it("shows both run-source inputs when Completed run output is selected", () => {
    render(<PriorContextSelect value="none" onChange={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /None/ }));
    fireEvent.click(
      screen.getByRole("button", { name: /Completed run output/ })
    );

    expect(
      screen.getByRole("button", { name: /Completed run output/ })
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Prior-context workflow")).toBeInTheDocument();
    expect(
      screen.getByLabelText("Prior-context run number")
    ).toBeInTheDocument();
    expect(
      screen.queryByLabelText("Number of previous step outputs")
    ).not.toBeInTheDocument();
  });

  it("writes the latest-run source from the workflow alone, then pins a run number", () => {
    const onChange = vi.fn();
    render(<PriorContextSelect value="none" onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: /None/ }));
    fireEvent.click(
      screen.getByRole("button", { name: /Completed run output/ })
    );
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Prior-context workflow"), {
      target: { value: "Bug Sweep " },
    });
    expect(onChange).toHaveBeenLastCalledWith({ workflow: "Bug Sweep" });
    expect(screen.getByLabelText("Prior-context workflow")).toHaveValue(
      "Bug Sweep "
    );

    const run = screen.getByLabelText("Prior-context run number");
    fireEvent.change(run, { target: { value: "12" } });
    expect(onChange).toHaveBeenLastCalledWith({
      workflow: "Bug Sweep",
      run: 12,
    });

    onChange.mockClear();
    fireEvent.change(run, { target: { value: "0" } });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("shows a stored source's workflow and run", () => {
    render(
      <PriorContextSelect
        value={{ workflow: "bug-sweep-2026-07-20T00-00-00", run: 3 }}
        onChange={vi.fn()}
      />
    );
    expect(screen.getByLabelText("Prior-context workflow")).toHaveValue(
      "bug-sweep-2026-07-20T00-00-00"
    );
    expect(screen.getByLabelText("Prior-context run number")).toHaveValue("3");
  });

  it("hides run-source inputs after switching to another keyword", () => {
    render(<PriorContextSelect value="none" onChange={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /None/ }));
    fireEvent.click(
      screen.getByRole("button", { name: /Completed run output/ })
    );
    expect(screen.getByLabelText("Prior-context workflow")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: /Completed run output/ })
    );
    fireEvent.click(
      screen.getByRole("button", { name: "All, priorContext: all" })
    );

    expect(
      screen.queryByLabelText("Prior-context workflow")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText("Prior-context run number")
    ).not.toBeInTheDocument();
  });
});
