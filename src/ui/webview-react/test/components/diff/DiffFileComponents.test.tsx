import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { DiffFileCard } from "@components/diff/DiffFileCard";
import { DiffFileList } from "@components/diff/DiffFileList";

vi.mock("@components/output/DiffView", () => ({
  DiffView: () => <div data-testid="diff-view" />,
}));

describe("DiffFileCard", () => {
  it("shows a real added-file path, no /dev/null, and a created tooltip on the icon", () => {
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
        globallyCollapsed
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
          globallyCollapsed
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
        globallyCollapsed
        note="Final Step Loop 1, Prompt 1, Prompt 2, Prompt 3, Prompt 4, Prompt 5"
      />
    );

    const note = screen.getByText(/Final Step Loop 1, Prompt 1/);
    expect(note.className).not.toContain("shrink-0");
    expect(container.querySelector(".shrink-0.italic")).toBeNull();
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
