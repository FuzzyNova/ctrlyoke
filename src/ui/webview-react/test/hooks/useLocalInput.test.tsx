import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { LocalNumberInput } from "@components/shared/LocalInputs";

function renderInput(
  value: number,
  onCommit: (value: number | undefined) => void
) {
  return render(
    <LocalNumberInput
      aria-label="Maximum parallel steps"
      value={value}
      onCommit={onCommit}
      parse={(raw) => parseInt(raw, 10) || 1}
    />
  );
}

afterEach(() => {
  cleanup();
});

describe("useLocalInput", () => {
  it("resets normalized number input text when commit keeps the external value", () => {
    const onCommit = vi.fn<(value: number | undefined) => void>();
    renderInput(1, onCommit);
    const input = screen.getByRole("spinbutton", {
      name: "Maximum parallel steps",
    });

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "0" } });
    fireEvent.blur(input);

    expect(onCommit).toHaveBeenCalledWith(1);
    expect(input).toHaveValue(1);
  });

  it("shows the committed value after a normal commit updates the external value", () => {
    const onCommit = vi.fn<(value: number | undefined) => void>();
    const view = renderInput(1, onCommit);
    const input = screen.getByRole("spinbutton", {
      name: "Maximum parallel steps",
    });

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "2" } });
    fireEvent.blur(input);
    view.rerender(
      <LocalNumberInput
        aria-label="Maximum parallel steps"
        value={2}
        onCommit={onCommit}
        parse={(raw) => parseInt(raw, 10) || 1}
      />
    );

    expect(onCommit).toHaveBeenCalledWith(2);
    expect(input).toHaveValue(2);
  });

  it("ignores external updates while the user is editing", () => {
    const onCommit = vi.fn<(value: number | undefined) => void>();
    const view = renderInput(1, onCommit);
    const input = screen.getByRole("spinbutton", {
      name: "Maximum parallel steps",
    });

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "2" } });
    view.rerender(
      <LocalNumberInput
        aria-label="Maximum parallel steps"
        value={3}
        onCommit={onCommit}
        parse={(raw) => parseInt(raw, 10) || 1}
      />
    );

    expect(input).toHaveValue(2);
    expect(onCommit).not.toHaveBeenCalled();

    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith(2);
  });
});
