import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceDiffPane } from "@components/workspace-viewer/WorkspaceDiffPane";
import { useUiStore } from "@store/uiStore";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";
import type { ParsedDiffFile } from "@utils/rdvAdapter";

vi.mock("@components/output/DiffView", () => ({
  DiffView: ({
    globallyCollapsed,
    localResetVersion,
  }: {
    globallyCollapsed: boolean;
    localResetVersion?: number;
  }) => (
    <div
      data-testid="diff-view"
      data-collapsed={String(globallyCollapsed)}
      data-reset-version={String(localResetVersion ?? 0)}
    />
  ),
}));

vi.mock("@utils/hostedApi", () => ({
  workspaceGitRefDiff: vi.fn(),
}));

vi.mock("@utils/diff", () => ({
  downloadTextFile: vi.fn(),
}));

const diffFile: ParsedDiffFile = {
  path: "src/file.ts",
  changeType: "modified",
  language: "typescript",
  diffType: "modify",
  hunks: [
    {
      content: "@@ -1,1 +1,1 @@",
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      changes: [
        {
          type: "normal",
          isNormal: true,
          oldLineNumber: 1,
          newLineNumber: 1,
          content: "const value = 1;",
        },
      ],
    },
  ],
};

beforeEach(() => {
  useWorkspaceViewerStore.getState().reset();
  useUiStore.getState().resetLayoutState();
});

describe("WorkspaceDiffPane commit diff controls", () => {
  it("collapses and expands commit diffs with pane-local state", async () => {
    const user = userEvent.setup();
    useUiStore.getState().collapseAllDiffs();
    useUiStore.getState().setUndoDialogDiffsCollapsed(true);
    useWorkspaceViewerStore.setState({
      diffFiles: [diffFile],
      diffRefLabel: "Commit abc1234",
      diffRefLoading: false,
    });

    render(<WorkspaceDiffPane />);

    expect(screen.getByTestId("diff-view")).toHaveAttribute(
      "data-collapsed",
      "false"
    );

    await user.click(
      screen.getByRole("button", { name: "Collapse all diffs" })
    );

    expect(screen.getByTestId("diff-view")).toHaveAttribute(
      "data-collapsed",
      "true"
    );
    expect(screen.getByTestId("diff-view")).toHaveAttribute(
      "data-reset-version",
      "1"
    );

    await user.click(screen.getByRole("button", { name: "Expand all diffs" }));

    expect(screen.getByTestId("diff-view")).toHaveAttribute(
      "data-collapsed",
      "false"
    );
    expect(screen.getByTestId("diff-view")).toHaveAttribute(
      "data-reset-version",
      "2"
    );
  });
});

describe("WorkspaceDiffPane commit details section", () => {
  it("does not render commit details when no commit info is available", () => {
    useWorkspaceViewerStore.setState({
      diffFiles: [diffFile],
      diffRefLabel: "Working Tree Changes",
      diffRefLoading: false,
      diffCommitInfo: null,
    });

    render(<WorkspaceDiffPane />);

    expect(screen.queryByTitle("Show commit details")).not.toBeInTheDocument();
  });

  it("shows the subject when collapsed and reveals body/metadata when expanded", async () => {
    const user = userEvent.setup();
    useWorkspaceViewerStore.setState({
      diffFiles: [diffFile],
      diffRefLabel: "Commit abc1234",
      diffRefLoading: false,
      diffCommitInfo: {
        hash: "abc1234567890",
        shortHash: "abc1234",
        subject: "Add new feature",
        body: "This is the detailed description.",
        author: "Jane Doe",
        authorEmail: "jane@example.com",
        date: "2026-06-01T12:00:00-00:00",
        relativeDate: "2 days ago",
      },
    });

    render(<WorkspaceDiffPane />);

    expect(screen.getByText("Add new feature")).toBeInTheDocument();
    expect(
      screen.queryByText("This is the detailed description.")
    ).not.toBeInTheDocument();

    await user.click(screen.getByTitle("Show commit details"));

    expect(
      screen.getByText("This is the detailed description.")
    ).toBeInTheDocument();
    expect(screen.getByText(/Jane Doe/)).toBeInTheDocument();
    expect(screen.getByText(/jane@example.com/)).toBeInTheDocument();
    expect(screen.getByText("abc1234567890")).toBeInTheDocument();
  });
});
