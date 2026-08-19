import { describe, it, expect, beforeEach, vi } from "vitest";
import { applyRoute, isApplyingRoute } from "@/navigation/applyRoute";
import { MESSAGE_TYPES } from "@/types/messages";
import { useUiStore } from "@store/uiStore";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";

const RUN = {
  workflowKey: "demo" as never,
  kind: "run" as const,
  runRef: "run-2026-07-20T10-30-00-000Z" as never,
};

function fakeVsCode() {
  return { postMessage: vi.fn() };
}

beforeEach(() => {
  useWorkspaceViewerStore.getState().reset();
  useUiStore.setState({
    displayedViewAddress: null,
    runSummaries: [],
    executionRunRef: null,
  });
});

describe("applyRoute", () => {
  it("loads a stable run address", () => {
    const api = fakeVsCode();
    applyRoute({ workflow: RUN }, api);
    expect(useUiStore.getState().displayedViewAddress).toEqual(RUN);
    expect(api.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MESSAGE_TYPES.LOAD_RUN_VIEW,
        address: RUN,
        requestId: expect.any(String),
      })
    );
  });

  it("does not reload the address already displayed", () => {
    useUiStore.setState({ displayedViewAddress: RUN });
    const api = fakeVsCode();
    applyRoute({ workflow: RUN }, api);
    expect(api.postMessage).not.toHaveBeenCalled();
  });

  it("opens the viewer on the search tab", () => {
    applyRoute(
      {
        viewer: "search",
        searchQuery: "use state",
        searchScope: "content",
        searchIncludeGitIgnored: true,
        searchRepo: "repo-2",
      },
      fakeVsCode()
    );
    const wv = useWorkspaceViewerStore.getState();
    expect(wv.isOpen).toBe(true);
    expect(wv.activeTab).toBe("search");
    expect(wv.searchQuery).toBe("use state");
    expect(wv.searchScope).toBe("content");
    expect(wv.searchIncludeGitIgnored).toBe(true);
    expect(wv.selectedRepoId).toBe("repo-2");
  });

  it("opens an explorer file and clears the guard afterwards", () => {
    applyRoute(
      { viewer: "explorer", file: "src/a.ts", lines: [3, 9] },
      fakeVsCode()
    );
    expect(useWorkspaceViewerStore.getState().pendingNavigation).toEqual({
      type: "file",
      filePath: "src/a.ts",
      startLine: 3,
      endLine: 9,
    });
    expect(isApplyingRoute()).toBe(false);
  });
});
