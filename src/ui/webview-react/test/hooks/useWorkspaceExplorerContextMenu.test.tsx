import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceExplorerContextMenu } from "@hooks/useWorkspaceExplorerContextMenu";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";
import { useSettingsStore } from "@store/settingsStore";
import type { WorkspaceEntry } from "@root/types/HostedWorkspaceViewerTypes";
import { MESSAGE_TYPES } from "@/types/messages";

const apiMocks = vi.hoisted(() => ({
  workspaceCopyEntry: vi.fn(),
  workspaceDeleteEntry: vi.fn(),
  workspaceMoveEntry: vi.fn(),
}));

const postMessage = vi.hoisted(() => vi.fn());
vi.mock("@hooks/useVsCodeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hooks/useVsCodeApi")>()),
  useVsCodeApi: () => ({ postMessage }),
}));

vi.mock("@utils/hostedApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@utils/hostedApi")>()),
  workspaceCopyEntry: apiMocks.workspaceCopyEntry,
  workspaceDeleteEntry: apiMocks.workspaceDeleteEntry,
  workspaceMoveEntry: apiMocks.workspaceMoveEntry,
}));

function TestHarness({
  entry,
  explorerPath = "src",
  onOpenFile = vi.fn(),
}: {
  entry: WorkspaceEntry;
  explorerPath?: string;
  onOpenFile?: (path: string) => void;
}) {
  const { openContextMenu, explorerContextMenuPortal } =
    useWorkspaceExplorerContextMenu({
      explorerPath,
      isRootsList: false,
      onRefresh: vi.fn(),
      onOpenFile,
      onViewFileHistory: onViewFileHistory,
    });

  // Render only what WorkspaceExplorerPane renders, so a modal the pane
  // would drop fails these tests.
  return (
    <>
      <button onClick={() => openContextMenu(20, 20, entry)}>Open menu</button>
      {explorerContextMenuPortal}
    </>
  );
}

const onViewFileHistory = vi.fn();

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useWorkspaceViewerStore.getState().reset();
  useSettingsStore
    .getState()
    .updateGlobalSetting("confirmDeleteOperations", true);
});

describe("useWorkspaceExplorerContextMenu file history", () => {
  it("shows the action only for files and passes a normalized path", () => {
    render(
      <TestHarness
        entry={{ name: "file.ts", path: "src\\file.ts", kind: "file" }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    fireEvent.click(screen.getByRole("button", { name: "View File History" }));
    expect(onViewFileHistory).toHaveBeenCalledWith("src/file.ts");

    cleanup();
    render(
      <TestHarness entry={{ name: "src", path: "src", kind: "directory" }} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    expect(
      screen.queryByRole("button", { name: "View File History" })
    ).not.toBeInTheDocument();
  });
});

describe("useWorkspaceExplorerContextMenu workflow actions", () => {
  const workflowLabels = ["Run Workflow", "Load Workflow", "Queue Workflow"];

  it("offers workflow actions for a workflow file and loads it", () => {
    render(
      <TestHarness
        entry={{
          name: "build.ctrlyoke.yaml",
          path: "flows\\build.ctrlyoke.yaml",
          kind: "file",
        }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    for (const label of workflowLabels)
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load Workflow" }));
    expect(postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.LOAD_WORKFLOW,
      filePath: "flows/build.ctrlyoke.yaml",
    });
  });

  it.each([
    { name: "file.ts", path: "src/file.ts", kind: "file" as const },
    { name: "flows", path: "flows", kind: "directory" as const },
  ])("omits workflow actions for $path", (entry) => {
    render(<TestHarness entry={entry} />);
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    for (const label of workflowLabels)
      expect(
        screen.queryByRole("button", { name: label })
      ).not.toBeInTheDocument();
  });
});

describe("useWorkspaceExplorerContextMenu file mutations", () => {
  it("drops selected drafts after a successful delete", async () => {
    apiMocks.workspaceDeleteEntry.mockResolvedValue(undefined);
    useWorkspaceViewerStore.setState({
      fileDrafts: { "src/file.ts": { content: "draft" } },
    });
    useWorkspaceViewerStore.getState().selectFile("src/file.ts");
    useWorkspaceViewerStore
      .getState()
      .setLoadedFileContent("src/file.ts", "disk");
    useWorkspaceViewerStore.getState().setFileContent("draft");
    render(
      <TestHarness
        entry={{ name: "file.ts", path: "src/file.ts", kind: "file" }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(screen.getByRole("dialog")).toHaveTextContent(
      "Delete “file.ts” permanently?"
    );
    expect(apiMocks.workspaceDeleteEntry).not.toHaveBeenCalled();
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Delete",
      })
    );

    await vi.waitFor(() =>
      expect(useWorkspaceViewerStore.getState().selectedFilePath).toBeNull()
    );
    expect(useWorkspaceViewerStore.getState().fileDrafts).toEqual({});
    expect(apiMocks.workspaceDeleteEntry).toHaveBeenCalledWith({
      path: "src/file.ts",
    });
  });

  it("does nothing when the delete confirmation is canceled", () => {
    render(
      <TestHarness
        entry={{ name: "file.ts", path: "src/file.ts", kind: "file" }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(apiMocks.workspaceDeleteEntry).not.toHaveBeenCalled();
  });

  it("deletes immediately when delete confirmations are disabled", async () => {
    useSettingsStore
      .getState()
      .updateGlobalSetting("confirmDeleteOperations", false);
    apiMocks.workspaceDeleteEntry.mockResolvedValue(undefined);
    render(
      <TestHarness
        entry={{ name: "file.ts", path: "src/file.ts", kind: "file" }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await vi.waitFor(() =>
      expect(apiMocks.workspaceDeleteEntry).toHaveBeenCalledWith({
        path: "src/file.ts",
      })
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("re-keys selected drafts after a successful cut and paste", async () => {
    apiMocks.workspaceMoveEntry.mockResolvedValue(undefined);
    useWorkspaceViewerStore.setState({
      fileDrafts: { "src/file.ts": { content: "draft" } },
    });
    useWorkspaceViewerStore.getState().selectFile("src/file.ts");
    useWorkspaceViewerStore
      .getState()
      .setLoadedFileContent("src/file.ts", "disk");
    useWorkspaceViewerStore.getState().setFileContent("draft");
    const onOpenFile = vi.fn();
    render(
      <TestHarness
        entry={{ name: "file.ts", path: "src/file.ts", kind: "file" }}
        explorerPath="archive"
        onOpenFile={onOpenFile}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    fireEvent.click(screen.getByRole("button", { name: "Cut" }));
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    fireEvent.click(screen.getByRole("button", { name: "Paste" }));

    await vi.waitFor(() =>
      expect(useWorkspaceViewerStore.getState().selectedFilePath).toBe(
        "archive/file.ts"
      )
    );
    expect(apiMocks.workspaceMoveEntry).toHaveBeenCalledWith({
      sourcePath: "src/file.ts",
      destDir: "archive",
    });
    expect(useWorkspaceViewerStore.getState().fileDrafts).toEqual({
      "archive/file.ts": { content: "draft" },
    });
    expect(onOpenFile).toHaveBeenCalledWith("archive/file.ts");
  });
});
