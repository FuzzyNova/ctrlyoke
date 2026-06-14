import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { WorkspaceCommitHistoryPane } from "@components/workspace-viewer/WorkspaceCommitHistoryPane";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";
import { workspaceGitRefDiff } from "@utils/hostedApi";

vi.mock("@utils/hostedApi", () => ({
  workspaceCheckoutBranch: vi.fn(),
  workspaceCheckoutCommit: vi.fn(),
  workspaceGitRefDiff: vi.fn(),
}));

const commit = {
  hash: "abc1234567890abcdef",
  shortHash: "abc1234",
  subject: "fix: commit view",
  author: "Dev",
  relativeDate: "1 hour ago",
  isHead: true,
  pushed: true,
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
});
