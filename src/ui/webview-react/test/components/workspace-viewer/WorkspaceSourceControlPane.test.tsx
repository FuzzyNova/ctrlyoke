import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceSourceControlPane } from "@components/workspace-viewer/WorkspaceSourceControlPane";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";
import { DIFF_PAYLOAD_KINDS } from "@root/types/DashboardConstants";

const mocks = vi.hoisted(() => ({
  workspaceDiff: vi.fn(),
  workspaceStatus: vi.fn(),
  workspaceRepos: vi.fn(),
  refreshCommitHistory: vi.fn(),
}));

vi.mock("@utils/hostedApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@utils/hostedApi")>()),
  workspaceDiff: mocks.workspaceDiff,
  workspaceStatus: mocks.workspaceStatus,
  workspaceRepos: mocks.workspaceRepos,
}));
vi.mock("@hooks/useVsCodeApi", () => ({
  useVsCodeApi: () => ({ postMessage: vi.fn() }),
}));
vi.mock("@hooks/useMediaQuery", () => ({ useIsMobile: () => false }));
vi.mock("@hooks/usePagedCommitHistory", () => ({
  usePagedCommitHistory: () => ({
    listingId: null,
    currentBranch: null,
    detached: false,
    refresh: mocks.refreshCommitHistory,
  }),
}));
vi.mock("@components/workspace-viewer/WorkspaceCommitArea", () => ({
  WorkspaceCommitArea: () => <div />,
}));
vi.mock("@components/workspace-viewer/WorkspaceCommitHistoryPane", () => ({
  WorkspaceCommitHistoryPane: () => <div />,
}));
vi.mock("@components/workspace-viewer/WorkspaceDiffPane", () => ({
  WorkspaceDiffPane: () => <div />,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const files = [
  {
    path: "src/a.ts",
    kind: "modified" as const,
    stagedStatus: null,
    unstagedStatus: "M",
  },
  {
    path: "src/b.ts",
    kind: "modified" as const,
    stagedStatus: null,
    unstagedStatus: "M",
  },
];

beforeEach(() => {
  useWorkspaceViewerStore.getState().reset();
  mocks.workspaceDiff.mockReset();
  mocks.workspaceStatus.mockResolvedValue({
    files,
    incomingCommitCount: 0,
    outgoingCommitCount: 0,
  });
  mocks.workspaceRepos.mockResolvedValue({ repos: [], prefixRepoIds: {} });
});

describe("WorkspaceSourceControlPane diff sequencing", () => {
  it("keeps loading until the latest selected file diff settles", async () => {
    const first = deferred<{
      path: string;
      kind: "modified";
      payloadKind: typeof DIFF_PAYLOAD_KINDS.TEXT;
      oldContent: string;
      newContent: string;
    }>();
    const second = deferred<{
      path: string;
      kind: "modified";
      payloadKind: typeof DIFF_PAYLOAD_KINDS.TEXT;
      oldContent: string;
      newContent: string;
    }>();
    mocks.workspaceDiff
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    render(<WorkspaceSourceControlPane />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /a\.ts/i })).toBeTruthy()
    );
    fireEvent.click(screen.getByRole("button", { name: /a\.ts/i }));
    fireEvent.click(screen.getByRole("button", { name: /b\.ts/i }));
    expect(useWorkspaceViewerStore.getState().diffLoading).toBe(true);

    await act(async () =>
      first.resolve({
        path: "src/a.ts",
        kind: "modified",
        payloadKind: DIFF_PAYLOAD_KINDS.TEXT,
        oldContent: "old A",
        newContent: "new A",
      })
    );
    expect(useWorkspaceViewerStore.getState().diffLoading).toBe(true);
    expect(useWorkspaceViewerStore.getState().diffNewContent).toBe("");

    await act(async () =>
      second.resolve({
        path: "src/b.ts",
        kind: "modified",
        payloadKind: DIFF_PAYLOAD_KINDS.TEXT,
        oldContent: "old B",
        newContent: "new B",
      })
    );
    expect(useWorkspaceViewerStore.getState().selectedDiffPath).toBe(
      "src/b.ts"
    );
    expect(useWorkspaceViewerStore.getState().diffNewContent).toBe("new B");
    expect(useWorkspaceViewerStore.getState().diffLoading).toBe(false);
  });
});
