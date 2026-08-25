import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { WorkspaceFileHistoryEntry } from "@root/types/HostedWorkspaceViewerTypes";
import type { PagedFileHistoryController } from "@hooks/usePagedFileHistory";
import type { VirtualizedListRange } from "@components/shared";
import type { WorkspaceFileHistoryDiffResponse } from "@root/types/HostedWorkspaceViewerTypes";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";
import { WorkspaceDiffPane } from "@components/workspace-viewer/WorkspaceDiffPane";

const { usePagedFileHistory } = vi.hoisted(() => ({
  usePagedFileHistory: vi.fn(),
}));
const { workspaceFileHistoryDiff } = vi.hoisted(() => ({
  workspaceFileHistoryDiff: vi.fn(),
}));

vi.mock("@hooks/usePagedFileHistory", () => ({ usePagedFileHistory }));
vi.mock("@utils/hostedApi", () => ({
  workspaceFileHistoryDiff,
  workspaceGitRefDiff: vi.fn(),
}));
vi.mock("@components/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@components/shared")>();
  return {
    ...actual,
    VirtualizedPagedList: (props: {
      totalCount: number;
      getItem: (index: number) => WorkspaceFileHistoryEntry | undefined;
      renderItem: (
        item: WorkspaceFileHistoryEntry,
        index: number
      ) => React.ReactNode;
    }) => {
      const item = props.getItem(0);
      return item ? <>{props.renderItem(item, 0)}</> : null;
    },
  };
});

const historyEntry: WorkspaceFileHistoryEntry = {
  hash: "commit-image",
  shortHash: "commit-i",
  subject: "Update logo",
  author: "Author",
  relativeDate: "today",
  isHead: true,
  pushed: true,
  refs: [],
  isMerge: false,
  parentHashes: ["parent"],
  path: "assets/logo.png",
  oldPath: "assets/logo.png",
};

const imageDetail: WorkspaceFileHistoryDiffResponse = {
  hash: historyEntry.hash,
  shortHash: historyEntry.shortHash,
  subject: historyEntry.subject,
  body: "",
  author: historyEntry.author,
  authorEmail: "author@example.com",
  date: "2026-08-25T12:00:00.000Z",
  relativeDate: historyEntry.relativeDate,
  path: historyEntry.path,
  oldPath: historyEntry.oldPath,
  changeType: "modified",
  payloadKind: "image",
  image: {
    oldImageDataUri: "data:image/png;base64,old",
    newImageDataUri: "data:image/png;base64,new",
  },
};

function historyController(): PagedFileHistoryController {
  return {
    path: historyEntry.path,
    repo: "repo-a",
    listingId: "history-1",
    totalCount: 1,
    pageSize: 30,
    getEntry: (index) => (index === 0 ? historyEntry : undefined),
    uniqueLoadedCount: 1,
    loadedCount: 1,
    loadedOffsets: [0],
    inFlightOffsets: [],
    failedRanges: [],
    initialLoading: false,
    isInitialLoading: false,
    pageLoading: false,
    isLoading: false,
    error: null,
    initialError: null,
    navigate: vi.fn(),
    navigateTo: vi.fn(),
    refresh: vi.fn(),
    retry: vi.fn(),
    retryPage: vi.fn(),
    requestRange: vi.fn(),
    loadRange: vi.fn(),
    onRangeChange: (_range: VirtualizedListRange) => undefined,
    onViewportRangeChange: (_range: VirtualizedListRange) => undefined,
  };
}

beforeEach(() => {
  useWorkspaceViewerStore.getState().reset();
  useWorkspaceViewerStore.getState().setSelectedRepoId("repo-a");
  usePagedFileHistory.mockReturnValue(historyController());
  workspaceFileHistoryDiff.mockResolvedValue(imageDetail);
});

describe("WorkspaceDiffPane file-history flow", () => {
  it("navigates to paged history, expands one card, and renders its image detail", async () => {
    useWorkspaceViewerStore.getState().openToFileHistory("assets\\logo.png");
    render(<WorkspaceDiffPane />);

    expect(screen.getByText("File History: assets/logo.png")).toBeInTheDocument();
    expect(screen.getByText(/Update logo · commit-i · Author · today/)).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Expand history diff" })
    );

    await waitFor(() =>
      expect(screen.getByAltText("assets/logo.png before")).toBeInTheDocument()
    );
    expect(screen.getByAltText("assets/logo.png after")).toBeInTheDocument();
    expect(workspaceFileHistoryDiff).toHaveBeenCalledWith(
      "assets/logo.png",
      "commit-image",
      "repo-a"
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Back to source control files" })
    );
    expect(useWorkspaceViewerStore.getState().fileHistoryActive).toBe(false);
    expect(useWorkspaceViewerStore.getState().fileHistoryPath).toBe(
      "assets/logo.png"
    );
  });
});
