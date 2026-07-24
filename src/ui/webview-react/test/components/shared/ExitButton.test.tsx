import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ExitButton } from "@components/shared/ExitButton";

describe("ExitButton", () => {
  it("uses the shared 24px control styling and centers its icon", () => {
    render(<ExitButton aria-label="Close panel" />);

    const button = screen.getByRole("button", { name: "Close panel" });
    expect(button).toHaveClass(
      "h-6",
      "w-6",
      "control-button",
      "appearance-none",
      "p-0",
      "leading-none"
    );
    expect(button.firstElementChild).toHaveClass("block", "leading-none");
  });

  it("forwards click handlers and button attributes", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <ExitButton
        aria-label="Close panel"
        className="ml-1"
        onClick={onClick}
        title="Close panel"
      />
    );

    await user.click(screen.getByRole("button", { name: "Close panel" }));

    expect(onClick).toHaveBeenCalledOnce();
    expect(screen.getByRole("button")).toHaveClass("ml-1");
    expect(screen.getByRole("button")).toHaveAttribute("type", "button");
  });
});
