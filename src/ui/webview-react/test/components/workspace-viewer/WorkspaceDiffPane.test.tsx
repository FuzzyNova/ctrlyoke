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
