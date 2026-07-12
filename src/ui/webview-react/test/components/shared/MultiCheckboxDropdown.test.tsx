import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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
});
