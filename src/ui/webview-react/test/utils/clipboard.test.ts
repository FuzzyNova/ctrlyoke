import { describe, expect, it, vi } from "vitest";
import { isEditableClipboardTarget, writeClipboardText } from "@utils/clipboard";

describe("clipboard", () => {
  it("recognizes editable targets", () => {
    expect(isEditableClipboardTarget(document.createElement("input"))).toBe(true);
    expect(isEditableClipboardTarget(document.createElement("div"))).toBe(false);
  });

  it("writes text through the clipboard API when available", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    await writeClipboardText("copied");
    expect(writeText).toHaveBeenCalledWith("copied");
  });
});
