import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LimitSelect } from "@components/shared/LimitSelect";
import { LIMIT_SELECTION_VALUES } from "@root/types/DashboardConstants";

function chooseOption(label: RegExp | string) {
  const trigger = screen.getByRole("button", {
    name: /property test\.limit/,
  });
  fireEvent.click(trigger);
  const listbox = screen.getByRole("listbox");
  fireEvent.click(within(listbox).getByRole("button", { name: label }));
}

describe("LimitSelect", () => {
  it.each([
    ["Unlimited", /Unlimited, test\.limit: -1/],
    ["Never", /Never, test\.limit: -1/],
  ] as const)("%s writes -1", (_label, optionName) => {
    const onChange = vi.fn();
    render(
      <LimitSelect
        id="test-limit"
        label="Test limit"
        path="test.limit"
        value={25}
        onChange={onChange}
        mode={
          _label === "Never"
            ? LIMIT_SELECTION_VALUES.NEVER
            : LIMIT_SELECTION_VALUES.UNLIMITED
        }
        customFallback={100}
      />
    );

    chooseOption(optionName);

    expect(onChange).toHaveBeenCalledWith(-1);
  });

  it("writes a custom number", () => {
    const onChange = vi.fn();
    render(
      <LimitSelect
        id="test-limit"
        label="Test limit"
        path="test.limit"
        value={25}
        onChange={onChange}
        customFallback={100}
      />
    );

    const input = screen.getByRole("spinbutton", {
      name: "Test limit Custom, property test.limit",
    });
    fireEvent.change(input, { target: { value: "42" } });
    fireEvent.blur(input);

    expect(onChange).toHaveBeenCalledWith(42);
  });

  it("prefills Custom with its fallback when the current value is unlimited", () => {
    const onChange = vi.fn();
    render(
      <LimitSelect
        id="test-limit"
        label="Test limit"
        path="test.limit"
        value={-1}
        onChange={onChange}
        customFallback={100}
      />
    );

    chooseOption(/Custom, test\.limit: <number>/);

    expect(onChange).toHaveBeenCalledWith(100);
  });

  it("removes the value when Inherit is selected", () => {
    const onChange = vi.fn();
    render(
      <LimitSelect
        id="test-limit"
        label="Test limit"
        path="test.limit"
        value={25}
        onChange={onChange}
        inheritLabel="50"
        customFallback={100}
      />
    );

    chooseOption(/Inherit \(50\), omit test\.limit/);

    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it.each([
    [50, "Inherit (50), property test.limit"],
    [-1, "Inherit (Unlimited), property test.limit"],
  ])("shows the resolved value in the Inherit label", (resolved, label) => {
    render(
      <LimitSelect
        id="test-limit"
        label="Test limit"
        path="test.limit"
        value={undefined}
        onChange={() => undefined}
        inheritLabel={resolved === -1 ? "Unlimited" : String(resolved)}
        customFallback={100}
      />
    );

    expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
  });
});
