import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { COPY_FEEDBACK_MS, CopyButton } from "@components/shared/CopyButton";
import { writeClipboardText } from "@utils/stepClipboard";

vi.mock("@utils/stepClipboard", () => ({
  writeClipboardText: vi.fn(() => Promise.resolve()),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.mocked(writeClipboardText).mockReset();
});

describe("CopyButton", () => {
  it("copies its text, shows a check mark, then reverts", async () => {
    vi.useFakeTimers();
    vi.mocked(writeClipboardText).mockResolvedValue();
    render(<CopyButton text="npm install -g x" label="Copy install command" />);

    const button = screen.getByRole("button", {
      name: "Copy install command",
    });
    await act(async () => {
      fireEvent.click(button);
    });

    expect(writeClipboardText).toHaveBeenCalledWith("npm install -g x");
    expect(button.querySelector(".codicon-check")).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(COPY_FEEDBACK_MS);
    });
    expect(button.querySelector(".codicon-copy")).not.toBeNull();
  });

  it("does not let the click reach a clickable parent row", async () => {
    vi.mocked(writeClipboardText).mockResolvedValue();
    const onRowClick = vi.fn();
    document.body.addEventListener("click", onRowClick);
    try {
      render(<CopyButton text="abc" label="Copy session ID" />);

      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: "Copy session ID" })
        );
      });

      expect(onRowClick).not.toHaveBeenCalled();
    } finally {
      document.body.removeEventListener("click", onRowClick);
    }
  });

  it("keeps the copy icon when the clipboard write fails", async () => {
    vi.mocked(writeClipboardText).mockRejectedValue(new Error("denied"));
    render(<CopyButton text="abc" label="Copy session ID" />);

    const button = screen.getByRole("button", { name: "Copy session ID" });
    await act(async () => {
      fireEvent.click(button);
    });

    expect(button.querySelector(".codicon-copy")).not.toBeNull();
  });
});
