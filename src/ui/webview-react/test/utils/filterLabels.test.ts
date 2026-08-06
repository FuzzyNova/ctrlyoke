import { describe, expect, it } from "vitest";
import { formatMultiFilterLabel } from "@utils/filterLabels";

const OPTIONS = [
  { value: "claude-cli", label: "Claude" },
  { value: "codex-cli", label: "Codex" },
  { value: "qwen-cli", label: "Qwen" },
];

describe("formatMultiFilterLabel", () => {
  it("labels an all-selected filter", () => {
    expect(
      formatMultiFilterLabel(
        ["claude-cli", "codex-cli", "qwen-cli"],
        ["claude-cli", "codex-cli", "qwen-cli"],
        "Harnesses",
        OPTIONS
      )
    ).toBe("All Harnesses");
  });

  it("uses the option label for exactly one selection", () => {
    expect(
      formatMultiFilterLabel(
        ["codex-cli"],
        ["claude-cli", "codex-cli", "qwen-cli"],
        "Harnesses",
        OPTIONS
      )
    ).toBe("Codex");
  });

  it("shows the selection count for multiple selections", () => {
    expect(
      formatMultiFilterLabel(
        ["claude-cli", "codex-cli"],
        ["claude-cli", "codex-cli", "qwen-cli"],
        "Harnesses",
        OPTIONS
      )
    ).toBe("2 Harnesses");
  });
});
