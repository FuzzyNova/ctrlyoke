import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MultiCheckboxDropdown } from "@components/shared/MultiCheckboxDropdown";

describe("MultiCheckboxDropdown", () => {
  it("renders a warning below the trigger and applies the warning border", () => {
    render(
      <MultiCheckboxDropdown
        id="skills"
        triggerAriaLabel="Skills"
        selectedValues={["missing"]}
        onChange={vi.fn()}
        options={[{ value: "lint", label: "Lint" }]}
        warning={'1 skill not found: "missing".'}
      />
    );

    expect(screen.getByRole("button")).toHaveClass("border-warning-fg");
    expect(screen.getByRole("button", { name: "Skills" })).toHaveAttribute(
      "aria-controls",
      "skills-listbox"
    );
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
    expect(header.querySelector("input")).toHaveProperty("indeterminate", true);
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
    // Only the new "All" header registers a checkbox role — individual option
    // rows hide their native checkbox from the a11y tree, as before.
    expect(screen.queryAllByRole("checkbox")).toHaveLength(1);
    expect(
      screen.getByRole("button", { name: "LintRun lint" })
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Test" })).toBeInTheDocument();
  });

  it("select-all header toggles every visible option, including grouped ones", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <MultiCheckboxDropdown
        id="events"
        selectedValues={[]}
        onChange={onChange}
        options={groupedOptions}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Select..." }));
    const allHeader = screen.getByRole("checkbox", { name: "All (0/4)" });
    expect(allHeader).toHaveAttribute("aria-checked", "false");

    fireEvent.click(allHeader);
    expect(onChange).toHaveBeenLastCalledWith([
      "read",
      "write",
      "bash",
      "tool",
    ]);

    rerender(
      <MultiCheckboxDropdown
        id="events"
        selectedValues={["read", "write", "bash", "tool"]}
        onChange={onChange}
        options={groupedOptions}
      />
    );
    const fullyCheckedHeader = screen.getByRole("checkbox", {
      name: "All (4/4)",
    });
    expect(fullyCheckedHeader).toHaveAttribute("aria-checked", "true");

    fireEvent.click(fullyCheckedHeader);
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it("marks the select-all header indeterminate when only some options are selected", () => {
    render(
      <MultiCheckboxDropdown
        id="events"
        selectedValues={["read"]}
        onChange={vi.fn()}
        options={groupedOptions}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Read" }));
    const allHeader = screen.getByRole("checkbox", { name: "All (1/4)" });
    expect(allHeader).toHaveAttribute("aria-checked", "mixed");
    expect(allHeader.querySelector("input")).toHaveProperty(
      "indeterminate",
      true
    );
  });

  it("does not show a select-all header for a single option", () => {
    render(
      <MultiCheckboxDropdown
        id="skills"
        selectedValues={[]}
        onChange={vi.fn()}
        options={[{ value: "lint", label: "Lint" }]}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Select..." }));
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
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

    expect(
      screen.queryByRole("button", { name: "Write" })
    ).not.toBeInTheDocument();
    expect(onDocumentKeyDown).not.toHaveBeenCalled();
    document.removeEventListener("keydown", onDocumentKeyDown);
  });
});
