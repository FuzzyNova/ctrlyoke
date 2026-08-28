import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { useUiStore } from "@store/uiStore";

const {
  mockGetRenderedDiffStats,
  mockDiff,
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
  mockDiff: vi.fn(
    ({
      children,
      diffType,
      hunks,
    }: {
      children: (h: unknown[]) => React.ReactNode;
      diffType: string;
      hunks: unknown[];
    }) =>
      React.createElement(
        "div",
        { className: "diff", "data-diff-type": diffType },
        children(hunks)
      )
  ),
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
  injectFindHighlightStyles: vi.fn(),
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
  locateActiveDiffMatch: vi.fn(() => null),
}));

vi.mock("react-diff-view", async () => {
  const React = await import("react");
  return {
    Diff: mockDiff,
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

import { useElementNarrow } from "@hooks/useElementNarrow";
import { DiffView } from "@components/output/DiffView";

describe("DiffView", () => {
  beforeEach(() => {
    useUiStore.setState({ diffsCollapsed: false, diffResetVersion: 0 });
    mockGetRenderedDiffStats.mockClear();
    mockDiff.mockClear();
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
    // Restored every test because the render-loop regression guard below swaps
    // in a counting implementation that can throw.
    vi.mocked(useElementNarrow).mockImplementation(() => [vi.fn(), true]);
  });

  it("renders nothing when there is no diff content", () => {
    const { container } = render(<DiffView globallyCollapsed={false} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows a summary toggle when collapsed", () => {
    mockGetRenderedDiffStats.mockReturnValue({
      added: 1,
      removed: 1,
      runs: [{ count: 1, addedLines: 1, removedLines: 1 }],
    });
    mockToRdvFromContent.mockReturnValue({
      hunks: [
        {
          content: "@@ -1,1 +1,1 @@",
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          changes: [
            { type: "delete", content: "-const a = 1;" },
            { type: "insert", content: "+const a = 2;" },
          ],
        },
      ],
      diffType: "modify",
    });
    const { getByText } = render(
      <DiffView
        oldContent={"const a = 1;\n"}
        newContent={"const a = 2;\n"}
        globallyCollapsed={true}
      />
    );
    expect(getByText(/Show diff/)).toBeTruthy();
    expect(getByText("+1")).toHaveClass("text-minimap-diff-added");
    expect(getByText("-1")).toHaveClass("text-minimap-diff-removed");
  });

  it("renders an empty base as an all-green added diff", () => {
    mockToRdvFromContent.mockReturnValue({
      hunks: [
        {
          content: "@@ -0,0 +1,1 @@",
          oldStart: 0,
          oldLines: 0,
          newStart: 1,
          newLines: 1,
          changes: [{ type: "insert", isInsert: true, content: "+new" }],
        },
      ],
      diffType: "add",
    });

    const { container } = render(
      <DiffView oldContent="" newContent={"new\n"} globallyCollapsed={false} />
    );

    expect(mockToRdvFromContent).toHaveBeenCalledWith("", "new\n");
    expect(
      container.querySelector(".diff")?.getAttribute("data-diff-type")
    ).toBe("add");
  });

  it("stops re-rendering when collapsed with uncontrolled gap state", () => {
    // Regression guard. While collapsed, `baseHunks` was a fresh `[]` literal
    // every render, and the gap-reset effect that depends on it always stored a
    // brand-new Map — never Object.is-equal to the previous state, so React
    // could never bail out. Render → effect → setState → render never
    // terminated, allocating on every pass until the heap died; it OOM'd the
    // entire UI suite (4GB) rather than failing.
    //
    // Deliberately pass neither `collapsed` nor `expandedGaps` — both pieces of
    // state must stay uncontrolled, which is the only configuration that looped.
    mockToRdvFromContent.mockReturnValue({
      hunks: [
        {
          content: "@@ -1,1 +1,1 @@",
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          changes: [
            { type: "delete", content: "-const a = 1;" },
            { type: "insert", content: "+const a = 2;" },
          ],
        },
      ],
      diffType: "modify",
    });

    // useElementNarrow is an unconditional hook call, so it runs once per
    // DiffView render. Throwing past a bound makes the guard trip *inside* the
    // loop: the runaway renders happen within render()'s act(), so any
    // assertion placed after it would never be reached — the process exhausts
    // its heap first. Tripping mid-loop turns a regression into a fast, legible
    // failure instead of a 4GB OOM that takes down the whole suite.
    const MAX_RENDERS = 50;
    let renders = 0;
    vi.mocked(useElementNarrow).mockImplementation(() => {
      renders += 1;
      if (renders > MAX_RENDERS) {
        throw new Error(
          `DiffView rendered more than ${MAX_RENDERS} times while collapsed — ` +
            `the uncontrolled gap-reset effect is looping again.`
        );
      }
      return [vi.fn(), true];
    });

    const { getByText } = render(
      <DiffView
        oldContent={"const a = 1;\n"}
        newContent={"const a = 2;\n"}
        globallyCollapsed={true}
      />
    );

    expect(getByText(/Show diff/)).toBeTruthy();
    expect(renders).toBeLessThanOrEqual(MAX_RENDERS);
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

  it("force-expands a collapsed diff (uncontrolled) that contains the active find match", () => {
    mockToRdvFromContent.mockReturnValue({
      hunks: [
        {
          content: "@@ -1,1 +1,1 @@",
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          changes: [
            { type: "delete", content: "-const a = 1;" },
            { type: "insert", content: "+const a = 2;" },
          ],
        },
      ],
      diffType: "modify",
    });

    // Otherwise-hidden content (behind "Show diff") can never be found or
    // scrolled to, so an active match must force it open.
    const { getByText } = render(
      <DiffView
        oldContent={"const a = 1;\n"}
        newContent={"const a = 2;\n"}
        globallyCollapsed={true}
        activeMatchRange={{ start: 0, end: 5 }}
      />
    );

    expect(getByText(/Hide diff/)).toBeTruthy();
  });

  it("force-expands a collapsed diff (controlled) that contains the active find match", () => {
    const onCollapsedChange = vi.fn();
    mockToRdvFromContent.mockReturnValue({
      hunks: [
        {
          content: "@@ -1,1 +1,1 @@",
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          changes: [
            { type: "delete", content: "-const a = 1;" },
            { type: "insert", content: "+const a = 2;" },
          ],
        },
      ],
      diffType: "modify",
    });

    render(
      <DiffView
        oldContent={"const a = 1;\n"}
        newContent={"const a = 2;\n"}
        globallyCollapsed={true}
        collapsed={true}
        onCollapsedChange={onCollapsedChange}
        activeMatchRange={{ start: 0, end: 5 }}
      />
    );

    expect(onCollapsedChange).toHaveBeenCalledWith(false);
  });

  it("supports controlled collapse state for virtualized rows", () => {
    const onCollapsedChange = vi.fn();

    const { rerender, getByRole } = render(
      <DiffView
        oldContent={"const a = 1;\n"}
        newContent={"const a = 2;\n"}
        globallyCollapsed={false}
        collapsed={true}
        onCollapsedChange={onCollapsedChange}
      />
    );

    fireEvent.click(getByRole("button", { name: /show diff/i }));
    expect(onCollapsedChange).toHaveBeenCalledWith(false);

    rerender(
      <DiffView
        oldContent={"const a = 1;\n"}
        newContent={"const a = 2;\n"}
        globallyCollapsed={false}
        collapsed={false}
        onCollapsedChange={onCollapsedChange}
      />
    );

    expect(getByRole("button", { name: /hide diff/i })).toBeTruthy();
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
    const hunk1 = {
      content: "@@ -1,1 +1,1 @@",
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      changes: [],
    };
    const hunk2 = {
      content: "@@ -6,1 +6,1 @@",
      oldStart: 6,
      oldLines: 1,
      newStart: 6,
      newLines: 1,
      changes: [],
    };
    mockToRdvFromContent.mockReturnValue({
      hunks: [hunk1, hunk2],
      diffType: "modify",
    });
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
    const hunk1 = {
      content: "@@ -1,1 +1,1 @@",
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      changes: [],
    };
    const hunk2 = {
      content: "@@ -42,1 +42,1 @@",
      oldStart: 42,
      oldLines: 1,
      newStart: 42,
      newLines: 1,
      changes: [],
    };
    mockToRdvFromContent.mockReturnValue({
      hunks: [hunk1, hunk2],
      diffType: "modify",
    });
    mockGetCollapsedLinesCountBetween.mockReturnValue(40);

    const oldContent = Array.from(
      { length: 42 },
      (_, i) => `line ${i + 1}`
    ).join("\n");
    const newContent = [
      "updated",
      ...Array.from({ length: 40 }, (_, i) => `line ${i + 2}`),
      "updated end",
    ].join("\n");

    const { getByRole } = render(
      <DiffView
        oldContent={oldContent}
        newContent={newContent}
        globallyCollapsed={false}
      />
    );

    fireEvent.click(
      getByRole("button", { name: /show 25 of 40 hidden lines/i })
    );

    // gapStart = 1 + 1 = 2, gapEnd = 42
    // chunk expandEnd = min(2 + 25, 42) = 27
    expect(mockExpandFromRawCode).toHaveBeenCalledWith(
      [hunk1, hunk2],
      oldContent,
      2,
      27
    );

    fireEvent.click(getByRole("button", { name: /show all/i }));

    // all expandEnd = gapEnd = 42
    expect(mockExpandFromRawCode).toHaveBeenLastCalledWith(
      [hunk1, hunk2],
      oldContent,
      2,
      42
    );
  });

  it("emits hidden-gap expansion intent when gap expansion is controlled", () => {
    const hunk1 = {
      content: "@@ -1,1 +1,1 @@",
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      changes: [],
    };
    const hunk2 = {
      content: "@@ -6,1 +6,1 @@",
      oldStart: 6,
      oldLines: 1,
      newStart: 6,
      newLines: 1,
      changes: [],
    };
    mockToRdvFromContent.mockReturnValue({
      hunks: [hunk1, hunk2],
      diffType: "modify",
    });
    mockGetCollapsedLinesCountBetween.mockReturnValue(4);
    const onExpandGap = vi.fn();

    const { getByRole } = render(
      <DiffView
        oldContent={"a\nb\nc\nd\ne\nf\n"}
        newContent={"A\nb\nc\nd\ne\nF\n"}
        globallyCollapsed={false}
        expandedGaps={new Map()}
        onExpandGap={onExpandGap}
      />
    );

    fireEvent.click(getByRole("button", { name: /show 4 hidden lines/i }));

    expect(onExpandGap).toHaveBeenCalledWith(1, 6);
  });

  it("shows hidden-line summaries as non-expandable when original file content is unavailable", () => {
    // Two hunks with a 4-line inter-hunk gap — no oldContent so expansion is unavailable.
    const hunk1 = {
      content: "@@ -1,1 +1,1 @@",
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      changes: [],
    };
    const hunk2 = {
      content: "@@ -6,1 +6,1 @@",
      oldStart: 6,
      oldLines: 1,
      newStart: 6,
      newLines: 1,
      changes: [],
    };
    mockToRdvHunks.mockReturnValue([hunk1, hunk2]);
    mockGetCollapsedLinesCountBetween.mockReturnValue(4);

    const { getByText, queryByRole } = render(
      <DiffView
        structuredPatch={[
          {
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            lines: ["-old1", "+new1"],
          },
          {
            oldStart: 6,
            oldLines: 1,
            newStart: 6,
            newLines: 1,
            lines: ["-old6", "+new6"],
          },
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

  it("tokenizes structured patch hunks without a potentially stale old source", () => {
    const hunks = [
      {
        content: "@@ -185,1 +185,1 @@",
        oldStart: 185,
        oldLines: 1,
        newStart: 185,
        newLines: 1,
        changes: [],
      },
    ];
    mockRefractorRegistered.mockReturnValue(true);
    mockToRdvHunks.mockReturnValue(hunks);

    render(
      <DiffView
        oldContent={"attempt-start content that no longer matches the patch"}
        newContent={"later event content"}
        structuredPatch={[
          {
            oldStart: 185,
            oldLines: 1,
            newStart: 185,
            newLines: 1,
            lines: ["-old CodeMirrorEditor", "+new CodeMirrorEditor"],
          },
        ]}
        language="typescript"
        globallyCollapsed={false}
      />
    );

    expect(mockTokenize).toHaveBeenCalledWith(
      hunks,
      expect.objectContaining({
        highlight: true,
        language: "typescript",
        oldSource: undefined,
        enhancers: expect.any(Array),
      })
    );
  });
});
