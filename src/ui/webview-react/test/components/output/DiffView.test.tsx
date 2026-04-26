import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { useUiStore } from "@store/uiStore";

const {
  mockGetRenderedDiffStats,
  mockToRdvHunks,
  mockToRdvFromContent,
} = vi.hoisted(() => ({
  mockGetRenderedDiffStats: vi.fn<
    () => {
      added: number;
      removed: number;
      runs: Array<{
        count: number;
        addedLines: number;
        removedLines: number;
      }>;
    }
  >(() => ({
    added: 0,
    removed: 0,
    runs: [],
  })),
  mockToRdvHunks: vi.fn<() => unknown[]>(() => []),
  mockToRdvFromContent: vi.fn<
    () => {
      hunks: Array<{
        content: string;
        oldStart: number;
        oldLines: number;
        newStart: number;
        newLines: number;
        changes: unknown[];
      }>;
      diffType: string;
    }
  >(() => ({ hunks: [], diffType: "modify" })),
}));

vi.mock("@utils/rdvAdapter", () => ({
  refractor: {
    registered: vi.fn(() => false),
    highlight: vi.fn(() => ({ children: [] })),
  },
  getRenderedDiffStats: mockGetRenderedDiffStats,
  toRdvHunks: mockToRdvHunks,
  toRdvFromContent: mockToRdvFromContent,
  normalizeLanguage: vi.fn((lang) => lang),
}));

vi.mock("react-diff-view", async () => {
  const React = await import("react");
  return {
    Diff: vi.fn(
      ({
        children,
        hunks,
      }: {
        children: (h: unknown[]) => React.ReactNode;
        hunks: unknown[];
      }) => React.createElement("div", { className: "diff" }, children(hunks))
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
    mockGetRenderedDiffStats.mockReturnValue({ added: 0, removed: 0, runs: [] });
    mockToRdvHunks.mockReturnValue([]);
    mockToRdvFromContent.mockReturnValue({ hunks: [], diffType: "modify" });
  });

  it("renders nothing when there is no diff content", () => {
    const { container } = render(<DiffView globallyCollapsed={false} />);
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

  it("publishes minimap metadata on the nearest diff anchor", async () => {
    mockToRdvFromContent.mockReturnValue({
      hunks: [
        {
          content: "@@ -1,1 +1,1 @@",
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          changes: [],
        },
      ],
      diffType: "modify",
    });
    mockGetRenderedDiffStats.mockReturnValue({
      added: 2,
      removed: 1,
      runs: [{ count: 1, addedLines: 1, removedLines: 1 }],
    });

    const { container } = render(
      <div data-diff-anchor="true">
        <DiffView
          oldContent={"const a = 1;\n"}
          newContent={"const a = 2;\n"}
          globallyCollapsed={false}
        />
      </div>
    );

    const anchor = container.querySelector("[data-diff-anchor='true']");
    expect(anchor).toBeTruthy();

    await waitFor(() => {
      expect(anchor?.getAttribute("data-diff-collapsed")).toBe("false");
    });
    expect(anchor?.getAttribute("data-diff-added-lines")).toBe("2");
    expect(anchor?.getAttribute("data-diff-removed-lines")).toBe("1");
    expect(anchor?.getAttribute("data-diff-runs")).toBe(
      JSON.stringify([{ count: 1, addedLines: 1, removedLines: 1 }])
    );
  });
});
