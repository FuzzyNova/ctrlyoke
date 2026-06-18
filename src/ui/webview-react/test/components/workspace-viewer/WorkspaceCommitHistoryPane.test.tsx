import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { WorkspaceCommitHistoryPane } from "@components/workspace-viewer/WorkspaceCommitHistoryPane";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";
import { workspaceGitRefDiff } from "@utils/hostedApi";
import type { WorkspaceCommitLogEntry } from "@root/types/HostedWorkspaceViewerTypes";

vi.mock("@utils/hostedApi", () => ({
  workspaceCheckoutBranch: vi.fn(),
  workspaceCheckoutCommit: vi.fn(),
  workspaceGitRefDiff: vi.fn(),
}));

const commit: WorkspaceCommitLogEntry = {
  hash: "abc1234567890abcdef",
  shortHash: "abc1234",
  subject: "fix: commit view",
  author: "Dev",
  relativeDate: "1 hour ago",
  isHead: true,
  pushed: true,
  refs: [{ name: "main", type: "localBranch" }],
  isMerge: false,
};

function commitRow(): HTMLElement {
  const subject = screen.getByText(commit.subject);
  const row = subject.closest("button");
  if (!row) throw new Error("Commit row button not found");
  return row;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(workspaceGitRefDiff).mockResolvedValue({ unifiedDiff: "" });
  useWorkspaceViewerStore.getState().reset();
  useWorkspaceViewerStore.setState({
    commitHistory: [commit],
    commitHistoryLoading: false,
    commitHistoryHasMore: false,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("WorkspaceCommitHistoryPane", () => {
  it("opens the mobile diff pane when a commit is clicked", () => {
    render(
      <WorkspaceCommitHistoryPane onLoadMore={vi.fn()} onRefresh={vi.fn()} />
    );

    fireEvent.click(commitRow());

    expect(useWorkspaceViewerStore.getState().mobileDiffVisible).toBe(true);
    expect(workspaceGitRefDiff).toHaveBeenCalledWith(`~${commit.hash}`);
  });

  it("outlines the commit currently shown in the diff pane", () => {
    useWorkspaceViewerStore.setState({ diffRef: `~${commit.hash}` });
    render(
      <WorkspaceCommitHistoryPane onLoadMore={vi.fn()} onRefresh={vi.fn()} />
    );

    expect(commitRow().className).toContain("outline-list-focus-outline");
  });

  it("does not outline any commit when a non-commit ref is viewed", () => {
    useWorkspaceViewerStore.setState({ diffRef: "~diff" });
    render(
      <WorkspaceCommitHistoryPane onLoadMore={vi.fn()} onRefresh={vi.fn()} />
    );

    expect(commitRow().className).not.toContain("outline-list-focus-outline");
  });

  it("opens the context menu on long press without also opening the diff", () => {
    vi.useFakeTimers();
    render(
      <WorkspaceCommitHistoryPane onLoadMore={vi.fn()} onRefresh={vi.fn()} />
    );

    const row = commitRow();
    fireEvent.touchStart(row, {
      touches: [{ clientX: 24, clientY: 36 }],
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(screen.getByText("Copy Hash")).toBeInTheDocument();

    fireEvent.click(row);

    expect(useWorkspaceViewerStore.getState().mobileDiffVisible).toBe(false);
    expect(workspaceGitRefDiff).not.toHaveBeenCalled();
  });

  it("shows the current branch name in the header", () => {
    useWorkspaceViewerStore.setState({ currentBranch: "main", detached: false });
    render(
      <WorkspaceCommitHistoryPane onLoadMore={vi.fn()} onRefresh={vi.fn()} />
    );

    const branchChip = screen.getByTitle("Current branch: main");
    expect(branchChip).toBeInTheDocument();
    expect(branchChip).toHaveTextContent("main");
  });

  it("shows a detached indicator when no current branch", () => {
    useWorkspaceViewerStore.setState({ currentBranch: null, detached: true });
    render(
      <WorkspaceCommitHistoryPane onLoadMore={vi.fn()} onRefresh={vi.fn()} />
    );

    expect(screen.getByText("detached")).toBeInTheDocument();
    expect(screen.getByText("Detached HEAD")).toBeInTheDocument();
  });

  it("renders ref pills from commit decorations", () => {
    useWorkspaceViewerStore.setState({
      commitHistory: [
        {
          ...commit,
          refs: [
            { name: "main", type: "localBranch" },
            { name: "origin/main", type: "remoteBranch" },
          ],
        },
      ],
    });
    render(
      <WorkspaceCommitHistoryPane onLoadMore={vi.fn()} onRefresh={vi.fn()} />
    );

    // "main" appears both in the header branch chip and as a ref pill.
    expect(screen.getAllByText("main").length).toBeGreaterThanOrEqual(1);
    // In-sync remote ref shares the row with its local branch, so it's
    // collapsed to just a cloud icon (no "origin/main" text).
    expect(screen.queryByText("origin/main")).not.toBeInTheDocument();
    expect(screen.getByTitle("origin/main")).toBeInTheDocument();
  });

  it("shows the full remote branch name when not sharing a row with a local branch ref", () => {
    useWorkspaceViewerStore.setState({
      commitHistory: [
        {
          ...commit,
          refs: [{ name: "origin/main", type: "remoteBranch" }],
        },
      ],
    });
    render(
      <WorkspaceCommitHistoryPane onLoadMore={vi.fn()} onRefresh={vi.fn()} />
    );

    expect(screen.getByText("origin/main")).toBeInTheDocument();
  });

  it("dims commits that are ahead of the detached HEAD", () => {
    const head = { ...commit, hash: "head", shortHash: "head000", isHead: true };
    const ahead = {
      ...commit,
      hash: "ahead",
      shortHash: "ahead00",
      subject: "feat: newer than head",
      isHead: false,
    };
    useWorkspaceViewerStore.setState({
      commitHistory: [ahead, head],
      detached: true,
    });
    render(
      <WorkspaceCommitHistoryPane onLoadMore={vi.fn()} onRefresh={vi.fn()} />
    );

    const aheadRow = screen
      .getByText("feat: newer than head")
      .closest("button");
    // The ahead commit's graph gutter is dimmed via opacity-60.
    expect(aheadRow?.querySelector(".opacity-60")).not.toBeNull();
  });

  it("renders the checkout-confirm modal elevated above the workspace viewer", () => {
    vi.useFakeTimers();
    // A non-HEAD commit so the "Checkout Commit" item is enabled.
    useWorkspaceViewerStore.setState({
      commitHistory: [{ ...commit, isHead: false }],
    });
    render(
      <WorkspaceCommitHistoryPane onLoadMore={vi.fn()} onRefresh={vi.fn()} />
    );

    fireEvent.touchStart(commitRow(), {
      touches: [{ clientX: 24, clientY: 36 }],
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });

    fireEvent.click(screen.getByText("Checkout Commit (Detach HEAD)"));

    // Regression guard: the confirm dialog must use the elevated z-layer so it
    // is not hidden behind the full-screen workspace viewer (z-workspace-viewer).
    expect(
      document.querySelector(".z-viewer-modal")
    ).not.toBeNull();
  });
});
