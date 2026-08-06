import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MultiCheckboxDropdown } from "@components/shared/MultiCheckboxDropdown";

describe("MultiCheckboxDropdown", () => {
  it("renders a warning below the trigger and applies the warning border", () => {
    render(
      <MultiCheckboxDropdown
        id="skills"
        selectedValues={["missing"]}
        onChange={vi.fn()}
        options={[{ value: "lint", label: "Lint" }]}
        warning={'1 skill not found: "missing".'}
      />
    );

    expect(screen.getByRole("button")).toHaveClass("border-warning-fg");
    expect(screen.getByText('1 skill not found: "missing".')).toHaveClass(
      "text-warning-fg"
    );
  });

  const groupedOptions = [
    { value: "read", label: "Read", group: "File" },
    { value: "write", label: "Write", group: "File" },
    { value: "bash", label: "Bash", group: "Execution" },
    { value: "tool", label: "Tool call", group: "Execution" },
  ];

  it("toggles only the header's section", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <MultiCheckboxDropdown
        id="events"
        selectedValues={["read", "bash"]}
        onChange={onChange}
        options={groupedOptions}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Read, Bash" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "File (1/2)" }));
    expect(onChange).toHaveBeenLastCalledWith(["read", "bash", "write"]);

    rerender(
      <MultiCheckboxDropdown
        id="events"
        selectedValues={["read", "write", "bash"]}
        onChange={onChange}
        options={groupedOptions}
      />
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "File (2/2)" }));
    expect(onChange).toHaveBeenLastCalledWith(["bash"]);
  });

  it("marks a partially selected section indeterminate", () => {
    render(
      <MultiCheckboxDropdown
        id="events"
        selectedValues={["read"]}
        onChange={vi.fn()}
        options={groupedOptions}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Read" }));
    const header = screen.getByRole("checkbox", { name: "File (1/2)" });
    expect(header).toHaveAttribute("aria-checked", "mixed");
    expect(header.querySelector("input")).toHaveProperty(
      "indeterminate",
      true
    );
  });

  it("emits grouped values as a flat string array", () => {
    const onChange = vi.fn();
    render(
      <MultiCheckboxDropdown
        id="events"
        selectedValues={[]}
        onChange={onChange}
        options={groupedOptions}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Select..." }));
    fireEvent.click(screen.getByRole("button", { name: "Write" }));
    expect(onChange).toHaveBeenCalledWith(["write"]);
  });

  it("keeps ungrouped options in the existing flat rendering", () => {
    render(
      <MultiCheckboxDropdown
        id="skills"
        selectedValues={[]}
        onChange={vi.fn()}
        options={[
          { value: "lint", label: "Lint", description: "Run lint" },
          { value: "test", label: "Test" },
        ]}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Select..." }));
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "LintRun lint" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Test" })).toBeInTheDocument();
  });

  it("closes on Escape without propagating to the document listener", () => {
    const onDocumentKeyDown = vi.fn();
    document.addEventListener("keydown", onDocumentKeyDown);

    render(
      <MultiCheckboxDropdown
        id="events"
        selectedValues={[]}
        onChange={vi.fn()}
        options={groupedOptions}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Select..." }));
    const option = screen.getByRole("button", { name: "Write" });
    expect(option).toBeInTheDocument();

    fireEvent.keyDown(option, { key: "Escape" });

    expect(screen.queryByRole("button", { name: "Write" })).not.toBeInTheDocument();
    expect(onDocumentKeyDown).not.toHaveBeenCalled();
    document.removeEventListener("keydown", onDocumentKeyDown);
  });
});
