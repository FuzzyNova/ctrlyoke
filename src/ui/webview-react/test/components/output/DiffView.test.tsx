import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { useUiStore } from "@store/uiStore";

vi.mock("@hooks/useElementNarrow", () => ({
  useElementNarrow: vi.fn(() => [vi.fn(), true]),
}));

vi.mock("@utils/hljsUtils", () => ({
  highlightLines: vi.fn(() => []),
  injectHljsStyles: vi.fn(),
}));

import { DiffView } from "@components/output/DiffView";

describe("DiffView", () => {
  beforeEach(() => {
    useUiStore.setState({ diffsCollapsed: false, diffResetVersion: 0 });
  });

  it("keeps inline diff row backgrounds as wide as the rendered content", () => {
    const { container } = render(
      <DiffView
        oldContent={"const value = 1;\n"}
        newContent={"const value = 12345678901234567890;\n"}
        globallyCollapsed={false}
      />
    );

    const changedRow = container.querySelector(".bg-diff-added-bg");
    expect(changedRow).toHaveClass("w-max");
    expect(changedRow).toHaveClass("min-w-full");
  });
});
