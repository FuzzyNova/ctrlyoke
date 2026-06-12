import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ErrorBehaviorEditor } from "@components/shared/ErrorBehaviorEditor";

describe("ErrorBehaviorEditor", () => {
  it("switches to retry mode and exposes retry controls", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(
      <ErrorBehaviorEditor
        value={{ onError: "stop" }}
        onChange={onChange}
        idPrefix="test-error"
      />
    );

    await user.click(screen.getAllByRole("button")[0]);
    await user.click(
      screen.getAllByText("Retry Step")[0].closest("button") as HTMLButtonElement
    );

    expect(onChange).toHaveBeenCalledWith({
      onError: "retry",
      maxRetries: 1,
      retryDelayMs: 0,
    });
  });

  it("commits retry numeric values on blur", () => {
    const onChange = vi.fn();

    render(
      <ErrorBehaviorEditor
        value={{ onError: "retry", maxRetries: 2, retryDelayMs: 500 }}
        onChange={onChange}
        idPrefix="test-error"
      />
    );

    const maxRetries = screen.getByLabelText("Max Retries");
    fireEvent.change(maxRetries, { target: { value: "4" } });
    fireEvent.blur(maxRetries);

    const retryDelay = screen.getByLabelText("Retry Delay (ms)");
    fireEvent.change(retryDelay, { target: { value: "1500" } });
    fireEvent.blur(retryDelay);

    expect(onChange).toHaveBeenNthCalledWith(1, {
      onError: "retry",
      maxRetries: 4,
      retryDelayMs: 500,
    });
    expect(onChange).toHaveBeenNthCalledWith(2, {
      onError: "retry",
      maxRetries: 2,
      retryDelayMs: 1500,
    });
  });
});
