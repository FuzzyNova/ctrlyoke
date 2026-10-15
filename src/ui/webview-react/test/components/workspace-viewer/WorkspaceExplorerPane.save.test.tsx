import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceExplorerPane } from "@components/workspace-viewer/WorkspaceExplorerPane";
import { useSettingsStore } from "@store/settingsStore";
import { useUiStore } from "@store/uiStore";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";

const mocks = vi.hoisted(() => ({
  workspaceSaveFile: vi.fn(),
  workspaceFile: vi.fn(),
  workspaceTree: vi.fn(),
  workspaceFileWatch: vi.fn(),
  workspaceStatus: vi.fn(),
}));

vi.mock("@utils/hostedApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@utils/hostedApi")>()),
  workspaceSaveFile: mocks.workspaceSaveFile,
  workspaceFile: mocks.workspaceFile,
  workspaceTree: mocks.workspaceTree,
  workspaceFileWatch: mocks.workspaceFileWatch,
  workspaceStatus: mocks.workspaceStatus,
}));
vi.mock("@hooks/useVsCodeApi", () => ({
  useVsCodeApi: () => ({ postMessage: vi.fn() }),
}));
vi.mock("@hooks/useMediaQuery", () => ({ useIsMobile: () => false }));
vi.mock("@hooks/useWorkspaceEditorContextMenu", () => ({
  useWorkspaceEditorContextMenu: () => ({
    openContextMenu: vi.fn(),
    editorContextMenuPortal: null,
    editorLongPressHandlers: {},
  }),
}));
vi.mock("@hooks/useWorkspaceExplorerContextMenu", () => ({
  useWorkspaceExplorerContextMenu: () => ({
    clipboard: null,
    openContextMenu: vi.fn(),
    explorerContextMenuPortal: null,
  }),
}));
vi.mock("@components/workspace-viewer/WorkspaceFileEditor", () => ({
  WorkspaceFileEditor: ({ content }: { content: string }) => (
    <div data-testid="file-editor">{content}</div>
  ),
}));
vi.mock("@components/output/MarkdownText", () => ({
  MarkdownText: () => <div />,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function openFile(path: string, content: string) {
  useWorkspaceViewerStore.getState().selectFile(path);
  useWorkspaceViewerStore.getState().setLoadedFileContent(path, content);
  useWorkspaceViewerStore.getState().setFileContent(`${content} edited`);
}

beforeEach(() => {
  useWorkspaceViewerStore.getState().reset();
  useSettingsStore.getState().updateGlobalSetting("workspaceRoot", "");
  useUiStore.getState().setMyClientId("browser:current");
  mocks.workspaceTree.mockResolvedValue({
    listingId: "save-test",
    pageSize: 100,
    entries: [],
    path: "",
    parentPath: null,
    rootLabel: "workspace",
    isGitRepo: false,
    isRootsList: false,
    totalEntries: 0,
    offset: 0,
  });
  mocks.workspaceFile.mockResolvedValue({
    content: "disk",
    path: "src/b.ts",
    modifiedAt: 20,
  });
  mocks.workspaceFileWatch.mockResolvedValue(undefined);
  mocks.workspaceStatus.mockResolvedValue({ files: [] });
  mocks.workspaceSaveFile.mockReset();
});

describe("WorkspaceExplorerPane save", () => {
  it("preserves edits typed while a save is in flight", async () => {
    const save = deferred<{ modifiedAt: number }>();
    mocks.workspaceSaveFile.mockReturnValue(save.promise);
    openFile("src/a.ts", "initial");
    render(<WorkspaceExplorerPane />);

    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(mocks.workspaceSaveFile).toHaveBeenCalledWith({
      path: "src/a.ts",
      content: "initial edited",
      baseModifiedAt: null,
    });

    act(() =>
      useWorkspaceViewerStore.getState().setFileContent("typed during save")
    );
    await act(async () => save.resolve({ modifiedAt: 10 }));

    const state = useWorkspaceViewerStore.getState();
    expect(state.fileContent).toBe("typed during save");
    expect(state.originalFileContent).toBe("initial edited");
    expect(state.fileDirty).toBe(true);
    expect(state.fileDrafts["src/a.ts"]?.content).toBe("typed during save");
  });

  it("does not apply a completed save to a different selected file", async () => {
    const save = deferred<{ modifiedAt: number }>();
    mocks.workspaceSaveFile.mockReturnValue(save.promise);
    openFile("src/a.ts", "file A");
    render(<WorkspaceExplorerPane />);

    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    act(() => {
      useWorkspaceViewerStore.getState().selectFile("src/b.ts");
      useWorkspaceViewerStore
        .getState()
        .setLoadedFileContent("src/b.ts", "file B");
      useWorkspaceViewerStore.getState().setFileContent("file B draft");
    });
    await act(async () => save.resolve({ modifiedAt: 10 }));

    await waitFor(() =>
      expect(useWorkspaceViewerStore.getState().fileSaving).toBe(false)
    );
    const state = useWorkspaceViewerStore.getState();
    expect(state.selectedFilePath).toBe("src/b.ts");
    expect(state.fileContent).toBe("file B draft");
    expect(state.originalFileContent).toBe("file B");
    expect(state.fileDirty).toBe(true);
    expect(state.fileDrafts["src/b.ts"]?.content).toBe("file B draft");
  });
});
