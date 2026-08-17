import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ActionButton } from "@components/shared/ActionButton";

describe("ActionButton", () => {
  it("renders the label and calls onClick", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<ActionButton label="Do thing" onClick={onClick} />);
    await user.click(screen.getByRole("button", { name: "Do thing" }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("shows the pending label and disables the button while pending", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <ActionButton
        label="Do thing"
        pendingLabel="Doing…"
        pending
        onClick={onClick}
      />
    );
    const btn = screen.getByRole("button", { name: "Doing…" });
    expect(btn).toBeDisabled();
    await user.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("shows the success label and blocks clicks while flashing", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <ActionButton
        label="Do thing"
        successLabel="Done!"
        success
        onClick={onClick}
      />
    );
    const btn = screen.getByRole("button", { name: "Done!" });
    expect(btn).toBeDisabled();
    await user.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("renders a below-button feedback line", () => {
    render(
      <ActionButton
        label="Do thing"
        onClick={vi.fn()}
        pending={false}
        feedback={{ status: "error", message: "It broke" }}
      />
    );
    expect(screen.getByRole("status")).toHaveTextContent("It broke");
  });

  it("renders as a link when href is provided, without a pending/success state", () => {
    render(
      <ActionButton
        label="Download certificate"
        icon="download"
        href="https://example.test/cert"
        download="ctrlyoke.cer"
      />
    );
    const link = screen.getByRole("link", { name: "Download certificate" });
    expect(link).toHaveAttribute("href", "https://example.test/cert");
    expect(link).toHaveAttribute("download", "ctrlyoke.cer");
  });
});
