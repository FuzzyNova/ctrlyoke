import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { useUiStore } from "@store/uiStore";

vi.mock("@utils/rdvAdapter", () => ({
  refractor: { registered: vi.fn(() => false), highlight: vi.fn(() => ({ children: [] })) },
  toRdvHunks: vi.fn(() => []),
  toRdvFromContent: vi.fn(() => ({ hunks: [], diffType: "modify" })),
  normalizeLanguage: vi.fn((lang) => lang),
}));

vi.mock("react-diff-view", async () => {
  const React = await import("react");
  return {
    Diff: vi.fn(({ children, hunks }: { children: (h: unknown[]) => React.ReactNode; hunks: unknown[] }) =>
      React.createElement("div", { className: "diff" }, children(hunks))
    ),
    Hunk: vi.fn(() => React.createElement("div", { className: "diff-hunk" })),
    Decoration: vi.fn(({ children }: { children: React.ReactNode }) =>
      React.createElement("div", { className: "diff-decoration" }, children)
    ),
    tokenize: vi.fn(() => null),
    markEdits: vi.fn(() => vi.fn()),
    getCollapsedLinesCountBetween: vi.fn(() => 0),
    expandFromRawCode: vi.fn((hunks: unknown[]) => hunks),
    parseDiff: vi.fn(() => []),
  };
});

vi.mock("@hooks/useElementNarrow", () => ({
  useElementNarrow: vi.fn(() => [vi.fn(), true]),
}));

import { DiffView } from "@components/output/DiffView";

describe("DiffView", () => {
  beforeEach(() => {
    useUiStore.setState({ diffsCollapsed: false, diffResetVersion: 0 });
  });

  it("renders nothing when there is no diff content", () => {
    const { container } = render(
      <DiffView globallyCollapsed={false} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("shows a summary toggle when collapsed", () => {
    const { getByText } = render(
      <DiffView
        oldContent={"const a = 1;\n"}
        newContent={"const a = 2;\n"}
        globallyCollapsed={true}
      />
    );
    expect(getByText(/Show diff/)).toBeTruthy();
  });

  it("shows diff when expanded", () => {
    const { getByText } = render(
      <DiffView
        oldContent={"const a = 1;\n"}
        newContent={"const a = 2;\n"}
        globallyCollapsed={false}
      />
    );
    expect(getByText(/Hide diff/)).toBeTruthy();
  });

  it("renders the actionSlot alongside the toggle", () => {
    const { getByText } = render(
      <DiffView
        oldContent={"const a = 1;\n"}
        newContent={"const a = 2;\n"}
        globallyCollapsed={false}
        actionSlot={<span>undo</span>}
      />
    );
    expect(getByText("undo")).toBeTruthy();
  });
});
