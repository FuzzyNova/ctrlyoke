import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setupBrowserNavigation } from "@/navigation/browserNavigation";
import { useBrowserHistoryStore } from "@/navigation/browserHistoryStore";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";
import { useUiStore } from "@store/uiStore";
import { WORKFLOW_VIEW_ADDRESS_KIND } from "@root/types/DashboardConstants";

let cleanup: (() => void) | null = null;

beforeEach(() => {
  useWorkspaceViewerStore.getState().reset();
  useUiStore.setState({
    displayedViewAddress: null,
    runSummaries: [],
    executionRunRef: null,
  });
  useBrowserHistoryStore.getState().reset();
  window.history.replaceState({}, "", "/?token=t");
});

afterEach(() => {
  cleanup?.();
  cleanup = null;
});

describe("setupBrowserNavigation", () => {
  it("restores the viewer from the initial URL", () => {
    window.history.replaceState(
      {},
      "",
      "/?token=t&viewer=explorer&file=src/a.ts"
    );
    cleanup = setupBrowserNavigation();

    const wv = useWorkspaceViewerStore.getState();
    expect(wv.isOpen).toBe(true);
    expect(wv.activeTab).toBe("explorer");
    expect(wv.pendingNavigation).toEqual({
      type: "file",
      filePath: "src/a.ts",
      startLine: undefined,
      endLine: undefined,
    });
    expect(useBrowserHistoryStore.getState().idx).toBe(0);
  });

  it("sets the document title from the initial URL", () => {
    window.history.replaceState(
      {},
      "",
      "/?token=t&viewer=explorer&file=src/a.ts"
    );
    cleanup = setupBrowserNavigation();
    expect(document.title).toBe("a.ts — ctrlyoke");
  });

  it("restores a shareable search URL", () => {
    window.history.replaceState(
      {},
      "",
      "/?token=t&viewer=search&query=use+state&scope=content&includeGitIgnored=true&repo=repo-2"
    );
    cleanup = setupBrowserNavigation();

    const wv = useWorkspaceViewerStore.getState();
    expect(wv.isOpen).toBe(true);
    expect(wv.activeTab).toBe("search");
    expect(wv.searchQuery).toBe("use state");
    expect(wv.searchScope).toBe("content");
    expect(wv.searchIncludeGitIgnored).toBe(true);
    expect(wv.selectedRepoId).toBe("repo-2");
  });

  it("keeps token-only startup as an implicit recent-workflow route", () => {
    window.history.replaceState({}, "", "/?token=t");
    cleanup = setupBrowserNavigation();

    // Server restores the most-recent workflow after a token-only load.
    useUiStore.getState().setDisplayedRunView(
      {
        workflowKey: "recent" as never,
        kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
      },
      [],
      undefined
    );

    expect(useBrowserHistoryStore.getState().idx).toBe(0);
    expect(new URLSearchParams(window.location.search).get("workflowKey")).toBe(
      null
    );
  });

  it("keeps an explicit initial workflow URL canonicalized to that workflow", () => {
    window.history.replaceState({}, "", "/?token=t&workflowKey=old");
    cleanup = setupBrowserNavigation();

    useUiStore
      .getState()
      .setDisplayedRunView(
        { workflowKey: "old" as never, kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT },
        [],
        undefined
      );

    expect(useBrowserHistoryStore.getState().idx).toBe(0);
    expect(new URLSearchParams(window.location.search).get("workflowKey")).toBe(
      "old"
    );
  });

  it("writes workflow to the URL after switching away from the implicit recent workflow", () => {
    window.history.replaceState({}, "", "/?token=t");
    cleanup = setupBrowserNavigation();

    useUiStore.getState().setDisplayedRunView(
      {
        workflowKey: "recent" as never,
        kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
      },
      [],
      undefined
    );
    expect(new URLSearchParams(window.location.search).get("workflowKey")).toBe(
      null
    );

    useUiStore.getState().setDisplayedRunView(
      {
        workflowKey: "other" as never,
        kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
        runRef: "run-2026-07-20T10-30-00-000Z" as never,
      },
      [],
      undefined
    );

    expect(useBrowserHistoryStore.getState()).toMatchObject({
      idx: 1,
      length: 2,
    });
    expect(new URLSearchParams(window.location.search).get("workflowKey")).toBe(
      "other"
    );
  });

  it("does not push a duplicate entry when a line-range deep link settles", () => {
    window.history.replaceState(
      {},
      "",
      "/?token=t&viewer=explorer&file=src/a.ts&lines=10-20"
    );
    cleanup = setupBrowserNavigation();

    // The explorer pane settles the selected file (without a line range).
    useWorkspaceViewerStore.setState({ selectedFilePath: "src/a.ts" });

    expect(useBrowserHistoryStore.getState().idx).toBe(0);
    expect(window.location.search).toContain("lines=10-20");
  });

  it("threads a deep-linked workflow into the ui store before READY", () => {
    window.history.replaceState(
      {},
      "",
      "/?token=t&workflowKey=demo&runRef=run-2026-07-20T10-30-00-000Z"
    );
    cleanup = setupBrowserNavigation();
    expect(useUiStore.getState().displayedViewAddress).toEqual({
      workflowKey: "demo",
      kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
      runRef: "run-2026-07-20T10-30-00-000Z",
    });
  });

  it("pushes a new history entry when the route settles to a new location", () => {
    window.history.replaceState({}, "", "/?token=t&viewer=explorer");
    cleanup = setupBrowserNavigation();

    // Simulate the explorer pane settling into a directory.
    useWorkspaceViewerStore.getState().setExplorerPath("src");

    expect(useBrowserHistoryStore.getState().idx).toBe(1);
    expect(window.location.search).toContain("dir=src");
    expect(window.location.search).toContain("token=t");
  });

  it("replaces search edits and returns to the search after opening a result", () => {
    window.history.replaceState({}, "", "/?token=t&viewer=search");
    cleanup = setupBrowserNavigation();

    useWorkspaceViewerStore.getState().setSearchQuery("use state");
    useWorkspaceViewerStore.getState().setSearchScope("content");

    expect(useBrowserHistoryStore.getState()).toMatchObject({
      idx: 0,
      length: 1,
    });
    expect(new URLSearchParams(window.location.search).get("query")).toBe(
      "use state"
    );
    expect(new URLSearchParams(window.location.search).get("scope")).toBe(
      "content"
    );

    useWorkspaceViewerStore.getState().openToFile("src/useState.ts");
    expect(useBrowserHistoryStore.getState()).toMatchObject({
      idx: 1,
      length: 2,
    });
    expect(new URLSearchParams(window.location.search).get("file")).toBe(
      "src/useState.ts"
    );

    window.history.replaceState(
      { idx: 0 },
      "",
      "/?token=t&viewer=search&query=use+state&scope=content"
    );
    window.dispatchEvent(new PopStateEvent("popstate", { state: { idx: 0 } }));

    const wv = useWorkspaceViewerStore.getState();
    expect(wv.activeTab).toBe("search");
    expect(wv.searchQuery).toBe("use state");
    expect(wv.searchScope).toBe("content");
  });

  it("pushes a ref URL when a commit diff becomes active", () => {
    window.history.replaceState({}, "", "/?token=t&viewer=scm");
    cleanup = setupBrowserNavigation();

    // Simulate a commit/ref diff becoming active (as openToGitRef would).
    useWorkspaceViewerStore.setState({ diffRef: "abc123" });

    expect(useBrowserHistoryStore.getState().idx).toBe(1);
    expect(window.location.search).toContain("ref=abc123");
  });

  it("applies the route on popstate and updates the index", () => {
    window.history.replaceState({}, "", "/?token=t&viewer=explorer");
    cleanup = setupBrowserNavigation();

    window.history.replaceState(
      { idx: 1 },
      "",
      "/?token=t&viewer=scm&file=src/c.ts"
    );
    window.dispatchEvent(new PopStateEvent("popstate", { state: { idx: 1 } }));

    const wv = useWorkspaceViewerStore.getState();
    expect(wv.activeTab).toBe("sourceControl");
    expect(wv.selectedDiffPath).toBe("src/c.ts");
    expect(useBrowserHistoryStore.getState().idx).toBe(1);
  });

  it("does not push stale file entries while a popstate file route settles", () => {
    window.history.replaceState(
      {},
      "",
      "/?token=t&viewer=explorer&file=src/a.ts"
    );
    cleanup = setupBrowserNavigation();

    useWorkspaceViewerStore.setState({ selectedFilePath: "src/a.ts" });
    useWorkspaceViewerStore.getState().openToFile("src/b.ts");
    useWorkspaceViewerStore.getState().clearPendingNavigation();
    useWorkspaceViewerStore.setState({ selectedFilePath: "src/b.ts" });

    expect(useBrowserHistoryStore.getState()).toMatchObject({
      idx: 1,
      length: 2,
    });
    expect(new URLSearchParams(window.location.search).get("file")).toBe(
      "src/b.ts"
    );

    window.history.replaceState(
      { idx: 0 },
      "",
      "/?token=t&viewer=explorer&file=src/a.ts"
    );
    window.dispatchEvent(new PopStateEvent("popstate", { state: { idx: 0 } }));

    // The explorer consumes pendingNavigation before it selects the requested
    // file. That transient old-file state must not become a fresh URL entry.
    useWorkspaceViewerStore.getState().clearPendingNavigation();
    expect(useBrowserHistoryStore.getState()).toMatchObject({
      idx: 0,
      length: 2,
    });
    expect(new URLSearchParams(window.location.search).get("file")).toBe(
      "src/a.ts"
    );

    useWorkspaceViewerStore.setState({ selectedFilePath: "src/a.ts" });
    expect(useBrowserHistoryStore.getState()).toMatchObject({
      idx: 0,
      length: 2,
    });
    expect(new URLSearchParams(window.location.search).get("file")).toBe(
      "src/a.ts"
    );
  });
});
