import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  cleanup,
} from "@testing-library/react";
import { useCommitHistoryContextMenu } from "@hooks/useCommitHistoryContextMenu";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";
import { workspaceCheckoutCommit } from "@utils/hostedApi";
import type { WorkspaceCommitLogEntry } from "@root/types/HostedWorkspaceViewerTypes";

vi.mock("@utils/hostedApi", () => ({
  workspaceCheckoutCommit: vi.fn(),
}));

const commit: WorkspaceCommitLogEntry = {
  hash: "abc1234567890abcdef",
  shortHash: "abc1234",
  subject: "fix: commit view",
  author: "Dev",
  relativeDate: "1 hour ago",
  isHead: false,
  pushed: true,
  refs: [],
  isMerge: false,
  parentHashes: [],
};

function TestHarness({ onRefresh }: { onRefresh: () => void }) {
  const { openContextMenu, commitHistoryContextMenuPortal } =
    useCommitHistoryContextMenu({ onRefresh });
  return (
    <>
      <button onClick={() => openContextMenu(20, 20, commit)}>Open menu</button>
      {commitHistoryContextMenuPortal}
    </>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useWorkspaceViewerStore.getState().reset();
  useWorkspaceViewerStore.setState({ currentBranch: "main", detached: false });
});

afterEach(() => {
  cleanup();
});

describe("useCommitHistoryContextMenu", () => {
  it("marks the store detached before refreshing so the post-checkout log keeps commits ahead visible", async () => {
    vi.mocked(workspaceCheckoutCommit).mockResolvedValue({ detached: true });
    // Capture whether the store was already detached at the moment onRefresh
    // fires — this is the regression: the branch hint depends on it.
    let detachedAtRefresh: boolean | null = null;
    const onRefresh = vi.fn(() => {
      detachedAtRefresh = useWorkspaceViewerStore.getState().detached;
    });

    render(<TestHarness onRefresh={onRefresh} />);

    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Checkout Commit (Detach HEAD)" })
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Checkout" }));
    });

    expect(workspaceCheckoutCommit).toHaveBeenCalledWith({ hash: commit.hash });
    expect(useWorkspaceViewerStore.getState().previousBranch).toBe("main");
    expect(useWorkspaceViewerStore.getState().detached).toBe(true);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(detachedAtRefresh).toBe(true);
  });
});
