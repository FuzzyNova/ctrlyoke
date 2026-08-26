import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WORKSPACE_ENTRY_KINDS } from "@root/types/DashboardConstants";
import {
  DEFAULT_WORKSPACE_ENTRY_SORT,
  WORKSPACE_ENTRY_SORT_DIRECTIONS,
  WORKSPACE_ENTRY_SORT_KEYS,
} from "@root/types/HostedWorkspaceViewerTypes";
import type {
  WorkspaceTreeEntry,
  WorkspaceTreePageRequest,
  WorkspaceTreePageResponse,
  WorkspaceTreeRangeRequest,
} from "@root/types/HostedWorkspaceViewerTypes";
import { WorkspaceExplorerPane } from "@components/workspace-viewer/WorkspaceExplorerPane";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";
import { useUiStore } from "@store/uiStore";
import { useSettingsStore } from "@store/settingsStore";
import { SCM_KIND_COLOR_CLASS } from "@utils/scmStatus";

const mocks = vi.hoisted(() => ({
  workspaceTree: vi.fn(),
  workspaceFile: vi.fn(),
  workspaceSaveFile: vi.fn(),
  workspaceStatus: vi.fn(),
  clipboard: null as { operation: "cut"; path: string } | null,
  contextOptions: null as {
    onRefresh: (affectedPath?: string) => void;
  } | null,
}));

vi.mock("@utils/hostedApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@utils/hostedApi")>()),
  workspaceTree: mocks.workspaceTree,
  workspaceFile: mocks.workspaceFile,
  workspaceSaveFile: mocks.workspaceSaveFile,
  workspaceStatus: mocks.workspaceStatus,
}));

vi.mock("@hooks/useVsCodeApi", () => ({
  useVsCodeApi: () => ({ postMessage: vi.fn() }),
}));

vi.mock("@hooks/useMediaQuery", () => ({
  useIsMobile: () => false,
}));

vi.mock("@hooks/useWorkspaceEditorContextMenu", () => ({
  useWorkspaceEditorContextMenu: () => ({
    openContextMenu: vi.fn(),
    editorContextMenuPortal: null,
    editorLongPressHandlers: {},
  }),
}));

vi.mock("@hooks/useWorkspaceExplorerContextMenu", () => ({
  useWorkspaceExplorerContextMenu: (options: {
    onRefresh: (affectedPath?: string) => void;
  }) => {
    mocks.contextOptions = options;
    return {
      clipboard: mocks.clipboard,
      openContextMenu: vi.fn(),
      explorerContextMenuPortal: null,
    };
  },
}));

vi.mock("@components/workspace-viewer/WorkspaceFileEditor", () => ({
  WorkspaceFileEditor: () => <div data-testid="file-editor" />,
}));

vi.mock("@components/output/MarkdownText", () => ({
  MarkdownText: () => <div />,
}));

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.getAttribute("data-testid") === "file-editor" ? 20 : 200;
    },
  });
});

function entry(index: number, ignored = false): WorkspaceTreeEntry {
  return {
    name: `file-${index}.ts`,
    path: `file-${index}.ts`,
    kind: WORKSPACE_ENTRY_KINDS.FILE,
    ...(ignored ? { gitIgnored: true } : {}),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function response(
  listingId: string,
  offset: number,
  totalEntries: number,
  entries: WorkspaceTreeEntry[],
  path = ""
): WorkspaceTreePageResponse {
  return {
    listingId,
    pageSize: 100,
    rootLabel: "workspace",
    path,
    parentPath: null,
    isGitRepo: true,
    isRootsList: false,
    totalEntries,
    offset,
    entries,
  };
}

function pageEntries(
  offset: number,
  totalEntries: number
): WorkspaceTreeEntry[] {
  return Array.from(
    { length: Math.min(100, totalEntries - offset) },
    (_unused, index) => entry(offset + index)
  );
}

function installPagedServer(totalEntries = 1205): void {
  let listingNumber = 0;
  mocks.workspaceTree.mockImplementation(
    async (request: WorkspaceTreePageRequest | WorkspaceTreeRangeRequest) => {
      if ("listingId" in request) {
        return response(
          request.listingId,
          request.offset,
          totalEntries,
          pageEntries(request.offset, totalEntries)
        );
      }

      listingNumber += 1;
      const anchorIndex = request.anchorPath
        ? Number(request.anchorPath.match(/file-(\d+)\.ts/)?.[1] ?? 0)
        : 0;
      const offset = Math.floor(anchorIndex / 100) * 100;
      const filteredEntries = request.includeGitIgnored
        ? pageEntries(offset, totalEntries)
        : pageEntries(offset, totalEntries).filter((item) => !item.gitIgnored);
      return response(
        `listing-${listingNumber}`,
        offset,
        totalEntries,
        filteredEntries
      );
    }
  );
}

beforeEach(() => {
  useWorkspaceViewerStore.getState().reset();
  useSettingsStore.getState().updateGlobalSetting("workspaceRoot", "");
  useSettingsStore.getState().updateGlobalSetting("hideGitIgnoredFiles", false);
  useUiStore.setState({ workspaceEntrySort: DEFAULT_WORKSPACE_ENTRY_SORT });
  mocks.workspaceTree.mockReset();
  mocks.workspaceFile.mockReset();
  mocks.workspaceSaveFile.mockReset();
  mocks.workspaceStatus.mockReset();
  mocks.clipboard = null;
  mocks.workspaceFile.mockResolvedValue({ content: "", path: "" });
  mocks.workspaceSaveFile.mockResolvedValue(undefined);
  mocks.workspaceStatus.mockResolvedValue({ files: [] });
  mocks.contextOptions = null;
  installPagedServer();
});

describe("WorkspaceExplorerPane pagination", () => {
  it("does not abort the only listing when consuming an initial directory navigation", async () => {
    mocks.workspaceTree.mockImplementation(async (request) => {
      if ("listingId" in request) {
        return response(
          request.listingId,
          request.offset,
          1,
          [entry(0)],
          "other"
        );
      }
      return response("initial-navigation", 0, 1, [entry(0)], request.path);
    });
    act(() => useWorkspaceViewerStore.getState().openToDirectory("other"));

    render(<WorkspaceExplorerPane />);
    await waitFor(() => expect(mocks.workspaceTree).toHaveBeenCalledOnce());

    expect(mocks.workspaceTree.mock.calls[0]?.[0]).toMatchObject({
      path: "other",
    });
    expect(
      (mocks.workspaceTree.mock.calls[0]?.[1] as AbortSignal).aborted
    ).toBe(false);
  });

  it("uses every server sort state, preserves selection, and refreshes saves with the active sort", async () => {
    const oldEntry = {
      ...entry(0),
      name: "old.ts",
      path: "old.ts",
      modifiedAt: 1,
    };
    const selectedEntry = {
      ...entry(1),
      name: "selected.ts",
      path: "selected.ts",
      modifiedAt: 3,
    };
    const newEntry = {
      ...entry(2),
      name: "new.ts",
      path: "new.ts",
      modifiedAt: 5,
    };
    let listingNumber = 0;
    mocks.workspaceFile.mockResolvedValue({
      content: "old",
      path: "selected.ts",
    });
    useWorkspaceViewerStore.getState().selectFile("selected.ts");
    useWorkspaceViewerStore
      .getState()
      .setLoadedFileContent("selected.ts", "old");
    useWorkspaceViewerStore.getState().setFileContent("new");
    mocks.clipboard = { operation: "cut", path: "selected.ts" };
    mocks.workspaceStatus.mockResolvedValue({
      files: [{ path: "selected.ts", kind: "modified" }],
    });
    mocks.workspaceTree.mockImplementation(async (request) => {
      if ("listingId" in request) {
        return response(request.listingId, request.offset, 3, [
          oldEntry,
          selectedEntry,
          newEntry,
        ]);
      }
      listingNumber += 1;
      const descending =
        request.sort?.key === WORKSPACE_ENTRY_SORT_KEYS.MODIFIED_AT &&
        request.sort.direction === WORKSPACE_ENTRY_SORT_DIRECTIONS.DESCENDING;
      const entries = descending
        ? [newEntry, selectedEntry, oldEntry]
        : [oldEntry, selectedEntry, newEntry];
      return response(`sorted-${listingNumber}`, 0, 3, entries);
    });

    render(<WorkspaceExplorerPane />);
    await screen.findByText("selected.ts");

    fireEvent.click(
      screen.getByRole("button", {
        name: /Date modified, inactive; selecting sorts descending/,
      })
    );
    await waitFor(() => expect(mocks.workspaceTree).toHaveBeenCalledTimes(2));
    expect(mocks.workspaceTree.mock.calls[1]?.[0]).toMatchObject({
      path: "",
      anchorPath: "selected.ts",
      includeGitIgnored: true,
      sort: {
        key: WORKSPACE_ENTRY_SORT_KEYS.MODIFIED_AT,
        direction: WORKSPACE_ENTRY_SORT_DIRECTIONS.DESCENDING,
      },
    });
    const selectedRow = screen.getByText("selected.ts").closest("button");
    expect(selectedRow).toHaveClass("fp-list-row-selected");
    expect(selectedRow).toHaveStyle({ opacity: "0.5" });
    expect(selectedRow?.querySelector("span")).toHaveClass(
      SCM_KIND_COLOR_CLASS.modified
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: /Date modified, currently descending/,
      })
    );
    await waitFor(() => expect(mocks.workspaceTree).toHaveBeenCalledTimes(3));
    expect(mocks.workspaceTree.mock.calls[2]?.[0]).toMatchObject({
      sort: {
        key: WORKSPACE_ENTRY_SORT_KEYS.MODIFIED_AT,
        direction: WORKSPACE_ENTRY_SORT_DIRECTIONS.ASCENDING,
      },
    });

    await act(async () => {
      fireEvent.click(screen.getByTitle("Save file"));
    });
    await waitFor(() => expect(mocks.workspaceSaveFile).toHaveBeenCalledOnce());
    await waitFor(() => expect(mocks.workspaceTree).toHaveBeenCalledTimes(4));
    expect(mocks.workspaceTree.mock.calls[3]?.[0]).toMatchObject({
      path: "",
      anchorPath: "selected.ts",
      sort: {
        key: WORKSPACE_ENTRY_SORT_KEYS.MODIFIED_AT,
        direction: WORKSPACE_ENTRY_SORT_DIRECTIONS.ASCENDING,
      },
    });
  });

  it("reaches entries past the old 1,000-entry cutoff with bounded mounts", async () => {
    render(<WorkspaceExplorerPane />);
    await waitFor(() =>
      expect(screen.getByText("file-0.ts")).toBeInTheDocument()
    );

    expect(screen.getAllByRole("button").length).toBeLessThan(40);
    act(() => useWorkspaceViewerStore.getState().selectFile("file-1100.ts"));
    const sync = screen.getByRole("button", {
      name: "Sync explorer to open file",
    });

    await act(async () => {
      fireEvent.click(sync);
    });

    const anchoredRequest = mocks.workspaceTree.mock.calls.find(
      ([request]) =>
        "anchorPath" in request && request.anchorPath === "file-1100.ts"
    );
    expect(anchoredRequest?.[0]).toMatchObject({
      path: "",
      anchorPath: "file-1100.ts",
    });
    expect(mocks.workspaceFile).not.toHaveBeenCalled();
    expect(screen.getAllByRole("button").length).toBeLessThan(40);
  });

  it("keeps navigation responses isolated from a stale directory", async () => {
    const first = deferred<WorkspaceTreePageResponse>();
    const second = deferred<WorkspaceTreePageResponse>();
    mocks.workspaceTree
      .mockReturnValueOnce(first.promise)
      .mockReturnValue(second.promise);

    render(<WorkspaceExplorerPane />);
    await waitFor(() => expect(mocks.workspaceTree).toHaveBeenCalledTimes(1));

    act(() => useWorkspaceViewerStore.getState().openToDirectory("other"));
    await waitFor(() =>
      expect(mocks.workspaceTree.mock.calls.length).toBeGreaterThanOrEqual(2)
    );

    await act(async () => {
      first.resolve(response("old", 0, 1, [entry(0)]));
      second.resolve(response("new", 0, 1, [entry(99)], "other"));
      await Promise.all([first.promise, second.promise]);
    });

    await waitFor(() =>
      expect(useWorkspaceViewerStore.getState().explorerPath).toBe("other")
    );
    expect(screen.getByText("file-99.ts")).toBeInTheDocument();
    expect(screen.queryByText("file-0.ts")).not.toBeInTheDocument();
  });

  it("anchors external open-to-file navigation before loading file contents", async () => {
    mocks.workspaceFile.mockResolvedValue({
      content: "export const opened = true;",
      path: "file-1100.ts",
    });
    act(() => useWorkspaceViewerStore.getState().openToFile("file-1100.ts"));

    render(<WorkspaceExplorerPane />);
    await waitFor(() => expect(mocks.workspaceFile).toHaveBeenCalledOnce());

    expect(
      mocks.workspaceTree.mock.calls.some(
        ([request]) =>
          "anchorPath" in request && request.anchorPath === "file-1100.ts"
      )
    ).toBe(true);
  });

  it("restarts the listing with server-side git-ignore filtering", async () => {
    mocks.workspaceTree.mockImplementationOnce(async () =>
      response("visible", 0, 2, [entry(0), entry(1, true)])
    );
    mocks.workspaceTree.mockImplementationOnce(async () =>
      response("hidden", 0, 1, [entry(0)])
    );

    render(<WorkspaceExplorerPane />);
    await waitFor(() =>
      expect(screen.getByText("file-1.ts")).toBeInTheDocument()
    );

    act(() => {
      useSettingsStore
        .getState()
        .updateGlobalSetting("hideGitIgnoredFiles", true);
    });

    await waitFor(() => expect(mocks.workspaceTree).toHaveBeenCalledTimes(2));
    expect(mocks.workspaceTree.mock.calls[1][0]).toMatchObject({
      includeGitIgnored: false,
    });
    await waitFor(() =>
      expect(screen.queryByText("file-1.ts")).not.toBeInTheDocument()
    );
  });

  it("refreshes from context-menu and save operations", async () => {
    useWorkspaceViewerStore.getState().selectFile("file-42.ts");
    useWorkspaceViewerStore
      .getState()
      .setLoadedFileContent("file-42.ts", "old");
    useWorkspaceViewerStore.getState().setFileContent("new");
    render(<WorkspaceExplorerPane />);
    await waitFor(() => expect(mocks.workspaceTree).toHaveBeenCalled());

    expect(mocks.contextOptions).not.toBeNull();
    act(() => mocks.contextOptions?.onRefresh("file-42.ts"));
    await waitFor(() =>
      expect(
        mocks.workspaceTree.mock.calls.some(
          ([request]) =>
            "anchorPath" in request && request.anchorPath === "file-42.ts"
        )
      ).toBe(true)
    );

    await act(async () => {
      fireEvent.click(screen.getByTitle("Save file"));
    });
    await waitFor(() => expect(mocks.workspaceSaveFile).toHaveBeenCalledOnce());
    expect(
      mocks.workspaceTree.mock.calls.filter(
        ([request]) =>
          "anchorPath" in request && request.anchorPath === "file-42.ts"
      )
    ).toHaveLength(2);
  });

  it("shows an inline retry after a failed listing refresh", async () => {
    render(<WorkspaceExplorerPane />);
    await waitFor(() =>
      expect(screen.getByText("file-0.ts")).toBeInTheDocument()
    );
    mocks.workspaceTree.mockRejectedValueOnce(new Error("listing failed"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh directory" }));
    await waitFor(() =>
      expect(screen.getByText("listing failed")).toBeInTheDocument()
    );

    mocks.workspaceTree.mockResolvedValueOnce(
      response("listing-retried", 0, 1205, pageEntries(0, 1205))
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(screen.getByText("file-0.ts")).toBeInTheDocument()
    );
  });

  it("does not request file contents while loading later pages, then opens only on selection", async () => {
    render(<WorkspaceExplorerPane />);
    await waitFor(() =>
      expect(screen.getByText("file-0.ts")).toBeInTheDocument()
    );
    expect(mocks.workspaceFile).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("file-0.ts"));
    await waitFor(() => expect(mocks.workspaceFile).toHaveBeenCalledOnce());
  });
});
