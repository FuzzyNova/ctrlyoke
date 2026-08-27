import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { ReactNode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceDiffPane } from "@components/workspace-viewer/WorkspaceDiffPane";
import { useUiStore } from "@store/uiStore";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";
import type { ParsedDiffFile } from "@utils/rdvAdapter";
import { workspaceGitRefDiff, workspaceGitRefDiffPage } from "@utils/hostedApi";
import type {
  WorkspaceCommitInfo,
  WorkspaceGitRefDiffEntry,
} from "@root/types/HostedWorkspaceViewerTypes";
import { downloadTextFile } from "@utils/diff";
import { MESSAGE_TYPES } from "@/types/messages";
import { DIFF_PAYLOAD_KINDS } from "@root/types/DashboardConstants";

vi.mock("@components/output/DiffView", () => ({
  DiffView: ({ collapsed }: { collapsed: boolean }) => (
    <div data-testid="diff-view" data-collapsed={String(collapsed)} />
  ),
}));

vi.mock("@utils/hostedApi", () => ({
  workspaceGitRefDiff: vi.fn(),
  workspaceGitRefDiffPage: vi.fn(),
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
    }) => (
      <div data-testid="virtualized-paged-list">
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

vi.mock("@utils/diff", () => ({
  downloadTextFile: vi.fn(),
}));

const originalOffsetHeight = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "offsetHeight"
);

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("flex-1") ? 600 : 40;
    },
  });
});

afterAll(() => {
  if (originalOffsetHeight) {
    Object.defineProperty(
      HTMLElement.prototype,
      "offsetHeight",
      originalOffsetHeight
    );
  }
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
  vi.mocked(workspaceGitRefDiffPage).mockReset();
  vi.mocked(downloadTextFile).mockReset();
  vi.mocked(workspaceGitRefDiffPage).mockResolvedValue(
    pageResponse([textEntry("src/file.ts")])
  );
});

describe("WorkspaceDiffPane commit diff controls", () => {
  it("downloads a commit diff using its full response hash", async () => {
    const user = userEvent.setup();
    vi.mocked(workspaceGitRefDiff).mockResolvedValue({
      unifiedDiff: "complete unified diff",
    });
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
      expect(workspaceGitRefDiff).toHaveBeenCalledWith(
        "~abc1234567890abcdef",
        undefined
      )
    );
    expect(downloadTextFile).toHaveBeenCalledWith(
      "ctrlyoke-commit-abc1234.diff",
      "complete unified diff"
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

    expect(screen.queryByTitle("Show commit details")).not.toBeInTheDocument();
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

    await user.click(screen.getByTitle("Show commit details"));

    expect(
      screen.getByText("This is the detailed description.")
    ).toBeInTheDocument();
    expect(screen.getByText(/Jane Doe/)).toBeInTheDocument();
    expect(screen.getByText(/jane@example.com/)).toBeInTheDocument();
    expect(screen.getByText("abc1234567890")).toBeInTheDocument();
  });
});
