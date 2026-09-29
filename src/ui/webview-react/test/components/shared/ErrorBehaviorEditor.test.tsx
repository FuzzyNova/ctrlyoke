import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ErrorBehaviorEditor } from "@components/shared/ErrorBehaviorEditor";

describe("ErrorBehaviorEditor", () => {
  it("shows the shared retry default when maxRetries is omitted", () => {
    render(
      <ErrorBehaviorEditor
        value={{ onError: "retry" }}
        onChange={vi.fn()}
      />
    );

    expect(screen.getByLabelText("Max Retries")).toHaveValue(1);
  });

  it("switches to retry mode and exposes retry controls", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(
      <ErrorBehaviorEditor
        value={{ onError: "stopWorkflow" }}
        onChange={onChange}
        idPrefix="test-error"
      />
    );

    await user.click(screen.getAllByRole("button")[0]);
    await user.click(
      screen.getAllByText("Retry")[0].closest("button") as HTMLButtonElement
    );

    expect(onChange).toHaveBeenCalledWith({
      onError: "retry",
      maxRetries: 1,
    });
  });

  it("uses shared action labels and annotates the schema property", () => {
    render(
      <ErrorBehaviorEditor
        value={{ onError: "stopWorkflow" }}
        onChange={vi.fn()}
        schemaPath="defaults.errorBehavior"
      />
    );

    const trigger = screen.getByRole("button", { name: /Stop Workflow/ });
    expect(trigger).toHaveAttribute(
      "aria-label",
      expect.stringContaining("defaults.errorBehavior.onError")
    );
    expect(trigger).toHaveAttribute(
      "title",
      expect.stringContaining("property: defaults.errorBehavior.onError")
    );
    fireEvent.click(trigger);
    expect(
      screen.getByRole("button", {
        name: "Retry, defaults.errorBehavior.onError: retry",
      })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Continue, defaults.errorBehavior.onError: continue",
      })
    ).toBeInTheDocument();
  });

  it("commits retry numeric values on blur", () => {
    const onChange = vi.fn();

    render(
      <ErrorBehaviorEditor
        value={{ onError: "retry", maxRetries: 2, retryDelaySec: 0.5 }}
        onChange={onChange}
        idPrefix="test-error"
      />
    );

    const maxRetries = screen.getByLabelText("Max Retries");
    fireEvent.change(maxRetries, { target: { value: "4" } });
    fireEvent.blur(maxRetries);

    const retryDelay = screen.getByLabelText("Retry Delay (s)");
    fireEvent.change(retryDelay, { target: { value: "1.5" } });
    fireEvent.blur(retryDelay);

    expect(onChange).toHaveBeenNthCalledWith(1, {
      onError: "retry",
      maxRetries: 4,
      retryDelaySec: 0.5,
    });
    expect(onChange).toHaveBeenNthCalledWith(2, {
      onError: "retry",
      maxRetries: 2,
      retryDelaySec: 1.5,
    });
  });
});
