import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { DiffFileCard } from "@components/diff/DiffFileCard";
import { DiffFileList } from "@components/diff/DiffFileList";

vi.mock("@components/output/DiffView", () => ({
  DiffView: () => <div data-testid="diff-view" />,
}));

describe("DiffFileCard", () => {
  it("shows a real added-file path and created badge", () => {
    render(
      <DiffFileCard
        path="src/new.ts"
        changeType="created"
        source={{
          kind: "content",
          oldContent: "",
          newContent: "const value = 1;",
        }}
        globallyCollapsed
      />
    );

    expect(screen.getByText("new.ts")).toBeInTheDocument();
    expect(screen.getByText("created")).toBeInTheDocument();
    expect(screen.queryByText("/dev/null")).not.toBeInTheDocument();
  });

  it("renders rename paths with both basenames and the full title", () => {
    render(
      <DiffFileCard
        path="src/new-name.ts"
        oldPath="src/old-name.ts"
        changeType="renamed"
        source={{ kind: "hunks", hunks: [], diffType: "modify" }}
        globallyCollapsed
      />
    );

    expect(screen.getByText("old-name.ts")).toBeInTheDocument();
    expect(screen.getByText("new-name.ts")).toBeInTheDocument();
    expect(
      screen.getByTitle("src/old-name.ts → src/new-name.ts")
    ).toBeInTheDocument();
    expect(screen.getByText("renamed")).toBeInTheDocument();
  });

  it("keeps the basename in the DOM while the directory is truncatable", () => {
    const { container } = render(
      <div style={{ width: 120 }}>
        <DiffFileCard
          path="very/long/directory/name/file.ts"
          changeType="modified"
          source={{ kind: "hunks", hunks: [], diffType: "modify" }}
          globallyCollapsed
        />
      </div>
    );

    expect(screen.getByText("file.ts")).toBeInTheDocument();
    expect(container.querySelector(".truncate")).toHaveTextContent(
      "very/long/directory/name/"
    );
  });
});

describe("DiffFileList", () => {
  it("does not enter a render loop when rendering card props", () => {
    const MAX_RENDERS = 25;
    let renderCount = 0;

    const GuardedList = () => {
      renderCount += 1;
      if (renderCount > MAX_RENDERS) {
        throw new Error("DiffFileList render loop");
      }
      return (
        <DiffFileList
          groups={[
            {
              files: [
                {
                  key: "src/file.ts",
                  path: "src/file.ts",
                  changeType: "modified",
                  source: { kind: "hunks", hunks: [], diffType: "modify" },
                  globallyCollapsed: true,
                },
              ],
            },
          ]}
          emptyMessage="No files"
        />
      );
    };

    render(<GuardedList />);

    expect(renderCount).toBeLessThan(MAX_RENDERS);
  });
});
