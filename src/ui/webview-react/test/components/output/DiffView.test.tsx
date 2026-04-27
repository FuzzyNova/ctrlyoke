import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { useUiStore } from "@store/uiStore";

const {
  mockGetRenderedDiffStats,
  mockToRdvHunks,
  mockToRdvFromContent,
  mockGetCollapsedLinesCountBetween,
  mockExpandFromRawCode,
  mockRefractorRegistered,
  mockTokenize,
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
  mockGetCollapsedLinesCountBetween: vi.fn(() => 0),
  mockExpandFromRawCode: vi.fn((hunks: unknown[]) => hunks),
  mockRefractorRegistered: vi.fn(() => false),
  mockTokenize: vi.fn(() => null),
}));

vi.mock("@utils/syntaxHighlighting", () => ({
  injectSyntaxHighlightStyles: vi.fn(),
  normalizeSyntaxLanguage: vi.fn((lang) => lang),
  refractor: {
    registered: mockRefractorRegistered,
    highlight: vi.fn(() => []),
  },
}));

vi.mock("@utils/rdvAdapter", () => ({
  getRenderedDiffStats: mockGetRenderedDiffStats,
  toRdvHunks: mockToRdvHunks,
  toRdvFromContent: mockToRdvFromContent,
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
    tokenize: mockTokenize,
    markEdits: vi.fn(() => vi.fn()),
    getCollapsedLinesCountBetween: mockGetCollapsedLinesCountBetween,
    expandFromRawCode: mockExpandFromRawCode,
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
    mockGetRenderedDiffStats.mockClear();
    mockToRdvHunks.mockClear();
    mockToRdvFromContent.mockClear();
    mockGetCollapsedLinesCountBetween.mockClear();
    mockExpandFromRawCode.mockClear();
    mockGetRenderedDiffStats.mockReturnValue({
      added: 0,
      removed: 0,
      runs: [],
    });
    mockToRdvHunks.mockReturnValue([]);
    mockToRdvFromContent.mockReturnValue({ hunks: [], diffType: "modify" });
    mockGetCollapsedLinesCountBetween.mockReturnValue(0);
    mockExpandFromRawCode.mockImplementation((hunks: unknown[]) => hunks);
    mockRefractorRegistered.mockReturnValue(false);
    mockTokenize.mockClear();
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

  it("expands a small hidden block in one click when original file content is available", () => {
    // Two hunks with a 4-line inter-hunk gap (lines 2-5 hidden between them).
    const hunk1 = { content: "@@ -1,1 +1,1 @@", oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, changes: [] };
    const hunk2 = { content: "@@ -6,1 +6,1 @@", oldStart: 6, oldLines: 1, newStart: 6, newLines: 1, changes: [] };
    mockToRdvFromContent.mockReturnValue({ hunks: [hunk1, hunk2], diffType: "modify" });
    mockGetCollapsedLinesCountBetween.mockReturnValue(4);

    const oldContent = "a\nb\nc\nd\ne\nf\n";
    const { getByRole } = render(
      <DiffView
        oldContent={oldContent}
        newContent={"A\nb\nc\nd\ne\nF\n"}
        globallyCollapsed={false}
      />
    );

    fireEvent.click(getByRole("button", { name: /show 4 hidden lines/i }));

    // gapStart = hunk1.oldStart + hunk1.oldLines = 1 + 1 = 2
    // gapEnd   = hunk2.oldStart = 6
    // expandEnd = min(2 + 25, 6) = 6
    expect(mockExpandFromRawCode).toHaveBeenCalledWith(
      [hunk1, hunk2],
      oldContent,
      2,
      6
    );
  });

  it("renders chunked and full expansion controls for large hidden blocks", () => {
    // Two hunks with a 40-line inter-hunk gap (lines 2-41 hidden between them).
    const hunk1 = { content: "@@ -1,1 +1,1 @@", oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, changes: [] };
    const hunk2 = { content: "@@ -42,1 +42,1 @@", oldStart: 42, oldLines: 1, newStart: 42, newLines: 1, changes: [] };
    mockToRdvFromContent.mockReturnValue({ hunks: [hunk1, hunk2], diffType: "modify" });
    mockGetCollapsedLinesCountBetween.mockReturnValue(40);

    const oldContent = Array.from({ length: 42 }, (_, i) => `line ${i + 1}`).join("\n");
    const newContent = ["updated", ...Array.from({ length: 40 }, (_, i) => `line ${i + 2}`), "updated end"].join("\n");

    const { getByRole } = render(
      <DiffView
        oldContent={oldContent}
        newContent={newContent}
        globallyCollapsed={false}
      />
    );

    fireEvent.click(getByRole("button", { name: /show 25 of 40 hidden lines/i }));

    // gapStart = 1 + 1 = 2, gapEnd = 42
    // chunk expandEnd = min(2 + 25, 42) = 27
    expect(mockExpandFromRawCode).toHaveBeenCalledWith([hunk1, hunk2], oldContent, 2, 27);

    fireEvent.click(getByRole("button", { name: /show all/i }));

    // all expandEnd = gapEnd = 42
    expect(mockExpandFromRawCode).toHaveBeenLastCalledWith([hunk1, hunk2], oldContent, 2, 42);
  });

  it("shows hidden-line summaries as non-expandable when original file content is unavailable", () => {
    // Two hunks with a 4-line inter-hunk gap — no oldContent so expansion is unavailable.
    const hunk1 = { content: "@@ -1,1 +1,1 @@", oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, changes: [] };
    const hunk2 = { content: "@@ -6,1 +6,1 @@", oldStart: 6, oldLines: 1, newStart: 6, newLines: 1, changes: [] };
    mockToRdvHunks.mockReturnValue([hunk1, hunk2]);
    mockGetCollapsedLinesCountBetween.mockReturnValue(4);

    const { getByText, queryByRole } = render(
      <DiffView
        structuredPatch={[
          { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-old1", "+new1"] },
          { oldStart: 6, oldLines: 1, newStart: 6, newLines: 1, lines: ["-old6", "+new6"] },
        ]}
        globallyCollapsed={false}
      />
    );

    const hiddenLines = getByText(/4 hidden lines/i);
    expect(queryByRole("button", { name: /show/i })).toBeNull();
    expect(hiddenLines.getAttribute("title")).toContain(
      "original file content is unavailable"
    );

    fireEvent.click(hiddenLines);
    expect(mockExpandFromRawCode).not.toHaveBeenCalled();
  });

  it("passes old source to react-diff-view tokenization when syntax highlighting is enabled", () => {
    const oldContent = "const value = 1;\n";
    const hunks = [
      {
        content: "@@ -1,1 +1,1 @@",
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        changes: [],
      },
    ];

    mockRefractorRegistered.mockReturnValue(true);
    mockToRdvFromContent.mockReturnValue({ hunks, diffType: "modify" });

    render(
      <DiffView
        oldContent={oldContent}
        newContent={"const value = 2;\n"}
        language="typescript"
        globallyCollapsed={false}
      />
    );

    expect(mockTokenize).toHaveBeenCalledWith(
      hunks,
      expect.objectContaining({
        highlight: true,
        language: "typescript",
        oldSource: oldContent,
        enhancers: expect.any(Array),
      })
    );
  });
});
