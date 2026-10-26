import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceDiffPane } from "@components/workspace-viewer/WorkspaceDiffPane";
import { useUiStore } from "@store/uiStore";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";
import { stubElementLayoutForFile } from "../../fixtures/elementLayout";
import type { ParsedDiffFile } from "@utils/rdvAdapter";
import {
  workspaceGitRefDiff,
  workspaceGitRefDiffDownload,
  workspaceGitRefDiffPage,
  workspaceWorktreeDiffPage,
} from "@utils/hostedApi";
import type {
  WorkspaceCommitInfo,
  WorkspaceGitRefDiffEntry,
} from "@root/types/HostedWorkspaceViewerTypes";
import { downloadBlob } from "@utils/download";
import { MESSAGE_TYPES } from "@/types/messages";
import { DIFF_PAYLOAD_KINDS } from "@root/types/DashboardConstants";

vi.mock("@components/output/DiffView", () => ({
  DiffView: ({ collapsed }: { collapsed: boolean }) => (
    <div data-testid="diff-view" data-collapsed={String(collapsed)} />
  ),
}));

vi.mock("@utils/hostedApi", () => ({
  hostedErrorMessage: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
  workspaceGitRefDiff: vi.fn(),
  workspaceGitRefDiffDownload: vi.fn(),
  workspaceGitRefDiffPage: vi.fn(),
  workspaceWorktreeDiffPage: vi.fn(),
}));

vi.mock("@components/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@components/shared")>();
  return {
    ...actual,
    VirtualizedPagedList: (props: {
      totalCount: number;
      getItem: (index: number) => WorkspaceGitRefDiffEntry | undefined;
      renderItem: (item: WorkspaceGitRefDiffEntry, index: number) => ReactNode;
      renderPlaceholder: (index: number) => ReactNode;
      onRangeChange?: (range: {
        visibleStartIndex: number;
        visibleEndIndex: number;
        overscanStartIndex: number;
        overscanEndIndex: number;
        startIndex: number;
        endIndex: number;
      }) => void;
    }) => (
      <div data-testid="virtualized-paged-list">
        <button
          type="button"
          aria-label="Load next diff page"
          onClick={() =>
            props.onRangeChange?.({
              visibleStartIndex: 20,
              visibleEndIndex: 20,
              overscanStartIndex: 20,
              overscanEndIndex: 20,
              startIndex: 20,
              endIndex: 20,
            })
          }
        />
        {Array.from(
          { length: Math.min(props.totalCount, 3) },
          (_unused, index) => {
            const item = props.getItem(index);
            return (
              <div key={index} data-test-row={index}>
                {item
                  ? props.renderItem(item, index)
                  : props.renderPlaceholder(index)}
              </div>
            );
          }
        )}
      </div>
    ),
  };
});

vi.mock("@utils/download", () => ({
  downloadBlob: vi.fn(),
}));

vi.mock("@utils/notifyUser", () => ({
  notifyUser: vi.fn(),
}));

import { notifyUser } from "@utils/notifyUser";

stubElementLayoutForFile({
  height: (element) => (element.classList.contains("flex-1") ? 600 : 40),
});

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

const commitInfo: WorkspaceCommitInfo = {
  hash: "abc1234567890abcdef",
  shortHash: "abc1234",
  subject: "fix: commit view",
  body: "",
  author: "Dev",
  authorEmail: "dev@example.com",
  date: "today",
  relativeDate: "today",
};

function textEntry(path: string): WorkspaceGitRefDiffEntry {
  return {
    path,
    changeType: "modified",
    payloadKind: DIFF_PAYLOAD_KINDS.TEXT,
    language: "typescript",
    oldContent: "const value = 0;",
    newContent: "const value = 1;",
  };
}

function pageResponse(
  entries: WorkspaceGitRefDiffEntry[],
  totalEntries = entries.length,
  offset = 0,
  responseCommitInfo: WorkspaceCommitInfo | undefined = commitInfo
) {
  return {
    diffId: "diff-1",
    pageSize: 20,
    totalEntries,
    offset,
    entries,
    commitInfo: responseCommitInfo,
  };
}

beforeEach(() => {
  useWorkspaceViewerStore.getState().reset();
  useUiStore.getState().resetLayoutState();
  vi.mocked(workspaceGitRefDiff).mockReset();
  vi.mocked(workspaceGitRefDiffDownload).mockReset();
  vi.mocked(workspaceGitRefDiffPage).mockReset();
  vi.mocked(workspaceWorktreeDiffPage).mockReset();
  vi.mocked(downloadBlob).mockReset();
  vi.mocked(notifyUser).mockReset();
  vi.mocked(workspaceGitRefDiffPage).mockResolvedValue(
    pageResponse([textEntry("src/file.ts")])
  );
  vi.mocked(workspaceWorktreeDiffPage).mockResolvedValue(
    pageResponse([textEntry("src/file.ts")])
  );
});

describe("WorkspaceDiffPane worktree diff paging", () => {
  it("loads worktree diff pages with the frozen snapshot id", async () => {
    vi.mocked(workspaceWorktreeDiffPage)
      .mockResolvedValueOnce(pageResponse([textEntry("src/file.ts")], 21))
      .mockResolvedValueOnce(pageResponse([], 21, 20, undefined));
    useWorkspaceViewerStore
      .getState()
      .openToWorktreeDiff("/repo", "base-hash", "feature/worktree");
    render(<WorkspaceDiffPane />);

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Open src/file.ts" })
      ).toBeInTheDocument()
    );
    expect(workspaceWorktreeDiffPage).toHaveBeenCalledWith(
      "/repo",
      "base-hash",
      "feature/worktree",
      0,
      20,
      undefined
    );
    expect(screen.getByText("Branch feature/worktree")).toBeInTheDocument();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Load next diff page" }));
    await waitFor(() =>
      expect(workspaceWorktreeDiffPage).toHaveBeenCalledTimes(2)
    );
    expect(workspaceWorktreeDiffPage).toHaveBeenLastCalledWith(
      "/repo",
      "base-hash",
      "feature/worktree",
      20,
      20,
      "diff-1"
    );
  });

  it("shows a retryable error when the first worktree page fails", async () => {
    const user = userEvent.setup();
    vi.mocked(workspaceWorktreeDiffPage).mockRejectedValueOnce(
      new Error("worktree page unavailable")
    );
    useWorkspaceViewerStore
      .getState()
      .openToWorktreeDiff("/repo", "base-hash", "feature/worktree");
    render(<WorkspaceDiffPane />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Unable to load diff."
    );
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(workspaceWorktreeDiffPage).toHaveBeenCalledTimes(2)
    );
  });
});

describe("WorkspaceDiffPane commit diff controls", () => {
  it("downloads a commit diff using its full response hash", async () => {
    const user = userEvent.setup();
    const diffBlob = new Blob(["complete unified diff"]);
    vi.mocked(workspaceGitRefDiffDownload).mockResolvedValue(diffBlob);
    vi.mocked(workspaceGitRefDiffPage).mockResolvedValue(
      pageResponse([textEntry("src/file.ts")])
    );
    useWorkspaceViewerStore.setState({
      diffRef: "~abc1234567890abcdef",
      diffRefLoading: false,
    });

    render(<WorkspaceDiffPane />);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Open src/file.ts" })
      ).toBeInTheDocument()
    );
    await user.click(screen.getByRole("button", { name: "Download" }));

    await waitFor(() =>
      expect(workspaceGitRefDiffDownload).toHaveBeenCalledWith(
        "~abc1234567890abcdef",
        undefined
      )
    );
    expect(downloadBlob).toHaveBeenCalledWith(
      "ctrlyoke-commit-abc1234.diff",
      diffBlob
    );
  });

  it("shows an error when the diff download fails", async () => {
    const user = userEvent.setup();
    vi.mocked(workspaceGitRefDiffDownload).mockRejectedValue(
      new Error("network unavailable")
    );
    useWorkspaceViewerStore.setState({
      diffRef: "~abc1234567890abcdef",
      diffRefLoading: false,
    });

    render(<WorkspaceDiffPane />);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Open src/file.ts" })
      ).toBeInTheDocument()
    );
    await user.click(screen.getByRole("button", { name: "Download" }));

    await waitFor(() =>
      expect(notifyUser).toHaveBeenCalledWith(
        "Failed to download diff",
        "error",
        "network unavailable"
      )
    );
  });

  it("renders commit image and binary entries even without text hunks", async () => {
    vi.mocked(workspaceGitRefDiffPage).mockResolvedValue(
      pageResponse(
        [
          {
            path: "assets/deleted.png",
            changeType: "deleted",
            payloadKind: DIFF_PAYLOAD_KINDS.IMAGE,
            image: { oldImageDataUri: "data:image/png;base64,old" },
          },
          {
            path: "assets/data.bin",
            changeType: "modified",
            payloadKind: DIFF_PAYLOAD_KINDS.BINARY,
          },
        ],
        2,
        0,
        undefined
      )
    );
    useWorkspaceViewerStore.setState({
      diffRef: "~abc1234",
    });

    render(<WorkspaceDiffPane />);

    await waitFor(() =>
      expect(screen.getByText("deleted.png")).toBeInTheDocument()
    );
    expect(screen.getByText("No new image")).toBeInTheDocument();
    expect(
      screen.getByText("binary diff preview unavailable")
    ).toBeInTheDocument();
  });

  it("collapses and expands commit diffs with pane-local state", async () => {
    const user = userEvent.setup();
    useUiStore.getState().collapseAllDiffs();
    useUiStore.getState().setUndoDialogDiffsCollapsed(true);
    vi.mocked(workspaceGitRefDiffPage).mockResolvedValue(
      pageResponse([textEntry("src/file.ts")])
    );
    useWorkspaceViewerStore.setState({
      diffRef: "~abc1234",
    });

    render(<WorkspaceDiffPane />);

    await waitFor(() =>
      expect(screen.getByTestId("diff-view")).toHaveAttribute(
        "data-collapsed",
        "false"
      )
    );

    await user.click(
      screen.getByRole("button", { name: "Collapse all diffs" })
    );

    expect(screen.getByTestId("diff-view")).toHaveAttribute(
      "data-collapsed",
      "true"
    );
    await user.click(screen.getByRole("button", { name: "Expand all diffs" }));

    expect(screen.getByTestId("diff-view")).toHaveAttribute(
      "data-collapsed",
      "false"
    );
  });

  it("renders added git-ref files with their real path and change-type icon", async () => {
    vi.mocked(workspaceGitRefDiffPage).mockResolvedValue(
      pageResponse([{ ...textEntry("src/new.ts"), changeType: "created" }])
    );
    useWorkspaceViewerStore.setState({
      diffRef: "~abc1234",
    });

    render(<WorkspaceDiffPane />);

    await waitFor(() => expect(screen.getByText("new.ts")).toBeInTheDocument());
    expect(screen.getByTitle("created")).toBeInTheDocument();
    expect(screen.queryByText("/dev/null")).not.toBeInTheDocument();
  });

  it("renders git-ref renames with old and new paths", async () => {
    vi.mocked(workspaceGitRefDiffPage).mockResolvedValue(
      pageResponse([
        {
          ...textEntry("src/new.ts"),
          oldPath: "src/old.ts",
          changeType: "renamed",
        },
      ])
    );
    useWorkspaceViewerStore.setState({
      diffRef: "~abc1234",
    });

    render(<WorkspaceDiffPane />);

    await waitFor(() => expect(screen.getByText("old.ts")).toBeInTheDocument());
    expect(screen.getByText("new.ts")).toBeInTheDocument();
    expect(screen.getByTitle("renamed")).toBeInTheDocument();
  });

  it("opens the file when the header's open-file button is clicked", async () => {
    const user = userEvent.setup();
    vi.mocked(workspaceGitRefDiffPage).mockResolvedValue(
      pageResponse([textEntry("src/file.ts")])
    );
    useWorkspaceViewerStore.setState({
      diffRef: "~abc1234",
    });
    const postMessage = vi.mocked(window.vscodeApi!.postMessage);
    postMessage.mockClear();

    render(<WorkspaceDiffPane />);

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Open src/file.ts" })
      ).toBeInTheDocument()
    );
    await user.click(screen.getByRole("button", { name: "Open src/file.ts" }));

    expect(postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.OPEN_FILE,
      path: "src/file.ts",
    });
  });

  it("opens a file from a visible virtualized row", async () => {
    const user = userEvent.setup();
    vi.mocked(workspaceGitRefDiffPage).mockResolvedValue(
      pageResponse([textEntry("src/file-0.ts")], 100)
    );
    useWorkspaceViewerStore.setState({
      diffRef: "~abc1234",
    });
    const postMessage = vi.mocked(window.vscodeApi!.postMessage);
    postMessage.mockClear();

    render(<WorkspaceDiffPane />);

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Open src/file-0.ts" })
      ).toBeInTheDocument()
    );
    await user.click(
      screen.getByRole("button", { name: "Open src/file-0.ts" })
    );

    expect(postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.OPEN_FILE,
      path: "src/file-0.ts",
    });
  });

  it("opens a large commit from its initial paged window", async () => {
    const firstPage = Array.from({ length: 20 }, (_unused, index) =>
      textEntry(`src/large-file-${index}.ts`)
    );
    vi.mocked(workspaceGitRefDiffPage).mockResolvedValue(
      pageResponse(firstPage, 1_000)
    );
    useWorkspaceViewerStore.setState({ diffRef: "~large-commit" });

    render(<WorkspaceDiffPane />);

    await waitFor(() =>
      expect(screen.getByText("large-file-0.ts")).toBeInTheDocument()
    );
    expect(workspaceGitRefDiffPage).toHaveBeenCalledWith(
      "~large-commit",
      0,
      20,
      undefined,
      undefined
    );
    expect(workspaceGitRefDiff).not.toHaveBeenCalled();
    expect(screen.getByText("1000 files")).toBeInTheDocument();
  });
});

describe("WorkspaceDiffPane single-file mode", () => {
  it("renders an image response instead of garbled text", () => {
    useWorkspaceViewerStore.setState({
      selectedDiffPath: "assets/logo.png",
      diffPayloadKind: DIFF_PAYLOAD_KINDS.IMAGE,
      diffImage: {
        oldImageDataUri: "data:image/png;base64,old",
        newImageDataUri: "data:image/png;base64,new",
      },
      diffKind: "modified",
      diffLoading: false,
      diffFiles: null,
    });

    render(<WorkspaceDiffPane />);

    expect(screen.getByAltText("assets/logo.png before")).toBeInTheDocument();
    expect(screen.queryByTestId("diff-view")).not.toBeInTheDocument();
  });

  it("renders the header and change-type icon derived from diffKind", () => {
    useWorkspaceViewerStore.setState({
      selectedDiffPath: "src/new.ts",
      diffOldContent: "",
      diffNewContent: "const value = 1;",
      diffKind: "added",
      diffLoading: false,
      diffFiles: null,
    });

    render(<WorkspaceDiffPane />);

    expect(screen.getByText("new.ts")).toBeInTheDocument();
    expect(screen.getByTitle("created")).toBeInTheDocument();
  });

  it("opens the file when the header's open-file button is clicked", async () => {
    const user = userEvent.setup();
    useWorkspaceViewerStore.setState({
      selectedDiffPath: "src/new.ts",
      diffOldContent: "",
      diffNewContent: "const value = 1;",
      diffKind: "added",
      diffLoading: false,
      diffFiles: null,
    });
    const postMessage = vi.mocked(window.vscodeApi!.postMessage);
    postMessage.mockClear();

    render(<WorkspaceDiffPane />);

    await user.click(screen.getByRole("button", { name: "Open src/new.ts" }));

    expect(postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.OPEN_FILE,
      path: "src/new.ts",
    });
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

    expect(
      screen.queryByRole("button", { name: "Toggle commit details" })
    ).not.toBeInTheDocument();
  });

  it("shows the subject when collapsed and reveals body/metadata when expanded", async () => {
    const user = userEvent.setup();
    const detailedCommitInfo: WorkspaceCommitInfo = {
      ...commitInfo,
      subject: "Add new feature",
      body: "This is the detailed description.",
      author: "Jane Doe",
      authorEmail: "jane@example.com",
      date: "2026-06-01T12:00:00-00:00",
      relativeDate: "2 days ago",
      hash: "abc1234567890",
    };
    vi.mocked(workspaceGitRefDiffPage).mockResolvedValue(
      pageResponse([textEntry("src/file.ts")], 1, 0, detailedCommitInfo)
    );
    useWorkspaceViewerStore.setState({
      diffRef: "~abc1234",
    });

    render(<WorkspaceDiffPane />);

    await waitFor(() =>
      expect(screen.getByText("Add new feature")).toBeInTheDocument()
    );
    expect(
      screen.queryByText("This is the detailed description.")
    ).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Toggle commit details" })
    );

    expect(
      screen.getByText("This is the detailed description.")
    ).toBeInTheDocument();
    expect(screen.getByText(/Jane Doe/)).toBeInTheDocument();
    expect(screen.getByText(/jane@example.com/)).toBeInTheDocument();
    expect(screen.getByText("abc1234567890")).toBeInTheDocument();
  });
});
