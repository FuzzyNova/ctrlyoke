import { beforeEach, describe, expect, it, vi } from "vitest";
import { WORKSPACE_ENTRY_KINDS } from "@root/types/DashboardConstants";
import { fireEvent, render, screen } from "@testing-library/react";
import { DiffFileCard } from "@components/diff/DiffFileCard";
import { DiffFileList } from "@components/diff/DiffFileList";
import { ImageDiffView } from "@components/diff/ImageDiffView";

const { diffViewRenderCount } = vi.hoisted(() => ({
  diffViewRenderCount: { value: 0 },
}));

vi.mock("@components/output/DiffView", () => ({
  DiffView: ({
    collapsed,
    expandedGaps,
    onCollapsedChange,
    onExpandGap,
  }: {
    collapsed?: boolean;
    expandedGaps?: Map<number, number>;
    onCollapsedChange?: (collapsed: boolean) => void;
    onExpandGap?: (gapIndex: number, nextExpandedToLine: number) => void;
  }) => {
    diffViewRenderCount.value += 1;
    if (diffViewRenderCount.value > 25) {
      throw new Error("DiffFileList render loop");
    }
    return (
      <div data-testid="diff-view">
        <div data-testid="diff-collapsed">{String(collapsed)}</div>
        <div data-testid="diff-expanded-gaps">
          {String(expandedGaps?.size ?? 0)}
        </div>
        <button
          type="button"
          aria-label="Toggle diff"
          onClick={() => onCollapsedChange?.(!collapsed)}
        />
        <button
          type="button"
          aria-label="Expand gap"
          onClick={() => onExpandGap?.(1, 27)}
        />
      </div>
    );
  },
}));

beforeEach(() => {
  diffViewRenderCount.value = 0;
});

function makeListFiles() {
  return [
    {
      key: "src/first.ts",
      path: "src/first.ts",
      changeType: "modified" as const,
      source: {
        kind: "hunks" as const,
        hunks: [],
        diffType: "modify" as const,
      },
    },
    {
      key: "src/second.ts",
      path: "src/second.ts",
      changeType: "modified" as const,
      source: {
        kind: "hunks" as const,
        hunks: [],
        diffType: "modify" as const,
      },
    },
  ];
}

function listProps(command: { version: number; collapsed: boolean }) {
  return {
    groups: [{ key: "files", files: makeListFiles() }],
    emptyMessage: "No files",
    command,
  };
}

describe("DiffFileCard", () => {
  it("renders before and after image sides with accessible labels", () => {
    render(
      <ImageDiffView
        path="assets/logo.png"
        sides={{
          oldImageDataUri: "data:image/png;base64,old",
          newImageDataUri: "data:image/png;base64,new",
        }}
      />
    );

    expect(screen.getByText("Before")).toBeInTheDocument();
    expect(screen.getByText("After")).toBeInTheDocument();
    expect(screen.getByAltText("assets/logo.png before")).toHaveAttribute(
      "src",
      "data:image/png;base64,old"
    );
    expect(screen.getByAltText("assets/logo.png after")).toHaveAttribute(
      "src",
      "data:image/png;base64,new"
    );
  });

  it("renders explicit placeholders for deleted and created image sides", () => {
    const { rerender } = render(
      <ImageDiffView
        path="assets/deleted.png"
        sides={{ oldImageDataUri: "old" }}
      />
    );

    expect(screen.getByText("No new image")).toBeInTheDocument();
    rerender(
      <ImageDiffView
        path="assets/created.png"
        sides={{ newImageDataUri: "new" }}
      />
    );
    expect(screen.getByText("No previous image")).toBeInTheDocument();
  });

  it("renders a compact binary fallback without DiffView props", () => {
    render(
      <DiffFileCard
        path="assets/data.bin"
        changeType="modified"
        source={{ kind: "binary" }}
      />
    );

    expect(
      screen.getByText("binary diff preview unavailable")
    ).toBeInTheDocument();
    expect(screen.queryByTestId("diff-view")).not.toBeInTheDocument();
  });

  it("shows a real added-file path, no /dev/null, and a created tooltip on the icon", () => {
    render(
      <DiffFileCard
        path="src/new.ts"
        changeType="created"
        source={{
          kind: WORKSPACE_ENTRY_KINDS.CONTENT,
          oldContent: "",
          newContent: "const value = 1;",
        }}
        collapsed
      />
    );

    expect(screen.getByText("new.ts")).toBeInTheDocument();
    expect(screen.getByTitle("created")).toBeInTheDocument();
    expect(screen.queryByText("/dev/null")).not.toBeInTheDocument();
    expect(screen.queryByText("created")).not.toBeInTheDocument();
  });

  it("renders rename paths with both basenames and the full title", () => {
    render(
      <DiffFileCard
        path="src/new-name.ts"
        oldPath="src/old-name.ts"
        changeType="renamed"
        source={{ kind: "hunks", hunks: [], diffType: "modify" }}
        collapsed
      />
    );

    expect(screen.getByText("old-name.ts")).toBeInTheDocument();
    expect(screen.getByText("new-name.ts")).toBeInTheDocument();
    expect(
      screen.getByTitle("src/old-name.ts → src/new-name.ts")
    ).toBeInTheDocument();
    expect(screen.getByTitle("renamed")).toBeInTheDocument();
  });

  it("keeps the basename in the DOM while the directory is truncatable", () => {
    const { container } = render(
      <div style={{ width: 120 }}>
        <DiffFileCard
          path="very/long/directory/name/file.ts"
          changeType="modified"
          source={{ kind: "hunks", hunks: [], diffType: "modify" }}
          collapsed
        />
      </div>
    );

    expect(screen.getByText("file.ts")).toBeInTheDocument();
    const truncatableTexts = Array.from(
      container.querySelectorAll(".truncate")
    ).map((el) => el.textContent);
    expect(truncatableTexts).toContain("very/long/directory/name/");
  });

  it("lets a long note wrap instead of clipping it", () => {
    const { container } = render(
      <DiffFileCard
        path="src/file.ts"
        changeType="modified"
        source={{ kind: "hunks", hunks: [], diffType: "modify" }}
        collapsed
        note="Final Step Pass 1, Prompt 1, Prompt 2, Prompt 3, Prompt 4, Prompt 5"
      />
    );

    const note = screen.getByText(/Final Step Pass 1, Prompt 1/);
    expect(note.className).not.toContain("shrink-0");
    expect(container.querySelector(".shrink-0.italic")).toBeNull();
  });
});

describe("DiffFileList", () => {
  it("does not enter a render loop when rendering card props", () => {
    const MAX_RENDERS = 25;
    render(
      <DiffFileList
        groups={[
          {
            files: [
              {
                key: "src/file.ts",
                path: "src/file.ts",
                changeType: "modified",
                source: { kind: "hunks", hunks: [], diffType: "modify" },
              },
            ],
          },
        ]}
        emptyMessage="No files"
        command={{ version: 0, collapsed: true }}
      />
    );

    expect(diffViewRenderCount.value).toBeLessThan(MAX_RENDERS);
  });

  it("keeps a manual collapse and expanded gap across parent prop rebuilds", () => {
    const view = render(
      <DiffFileList {...listProps({ version: 0, collapsed: false })} />
    );
    const toggles = screen.getAllByRole("button", { name: "Toggle diff" });
    const gapButtons = screen.getAllByRole("button", { name: "Expand gap" });

    fireEvent.click(toggles[0]);
    fireEvent.click(gapButtons[0]);
    expect(screen.getAllByTestId("diff-collapsed")[0]).toHaveTextContent(
      "true"
    );
    expect(screen.getAllByTestId("diff-expanded-gaps")[0]).toHaveTextContent(
      "1"
    );

    view.rerender(
      <DiffFileList {...listProps({ version: 0, collapsed: false })} />
    );

    expect(screen.getAllByTestId("diff-collapsed")[0]).toHaveTextContent(
      "true"
    );
    expect(screen.getAllByTestId("diff-expanded-gaps")[0]).toHaveTextContent(
      "1"
    );
  });

  it("applies a new command version immediately to every unchanged card", () => {
    const files = makeListFiles();
    const view = render(
      <DiffFileList
        groups={[{ key: "files", files }]}
        emptyMessage="No files"
        command={{ version: 0, collapsed: false }}
      />
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Toggle diff" })[0]);
    fireEvent.click(screen.getAllByRole("button", { name: "Expand gap" })[0]);

    view.rerender(
      <DiffFileList
        groups={[{ key: "files", files }]}
        emptyMessage="No files"
        command={{ version: 1, collapsed: true }}
      />
    );

    expect(screen.getAllByTestId("diff-collapsed")[0]).toHaveTextContent(
      "true"
    );
    expect(screen.getAllByTestId("diff-collapsed")[1]).toHaveTextContent(
      "true"
    );
    expect(screen.getAllByTestId("diff-expanded-gaps")[0]).toHaveTextContent(
      "0"
    );
  });

  it("re-expands a manually collapsed file when Expand all is pressed again", () => {
    const view = render(
      <DiffFileList {...listProps({ version: 0, collapsed: false })} />
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Toggle diff" })[0]);

    view.rerender(
      <DiffFileList {...listProps({ version: 1, collapsed: false })} />
    );

    expect(screen.getAllByTestId("diff-collapsed")[0]).toHaveTextContent(
      "false"
    );
  });

  it("prunes local state when a file row disappears", () => {
    const files = makeListFiles();
    const view = render(
      <DiffFileList
        groups={[{ key: "files", files }]}
        emptyMessage="No files"
        command={{ version: 0, collapsed: false }}
      />
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Toggle diff" })[0]);

    view.rerender(
      <DiffFileList
        groups={[]}
        emptyMessage="No files"
        command={{ version: 0, collapsed: false }}
      />
    );
    view.rerender(
      <DiffFileList
        groups={[{ key: "files", files }]}
        emptyMessage="No files"
        command={{ version: 0, collapsed: false }}
      />
    );

    expect(screen.getAllByTestId("diff-collapsed")[0]).toHaveTextContent(
      "false"
    );
  });
});
