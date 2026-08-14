/**
 * Tests for FileBrowserModal.
 *
 * FileBrowserModal takes no props — it is driven entirely by
 * uiStore.fileBrowserState (openFileBrowser/closeFileBrowser), so tests seed
 * that state directly before rendering, mirroring WorkspaceViewerModal.test.tsx.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FileBrowserModal } from "@components/workflow/FileBrowserModal";
import { useUiStore } from "@store/uiStore";
import { workspaceTree } from "@utils/hostedApi";
import type { WorkspaceTreeResponse } from "@root/types/HostedWorkspaceViewerTypes";

vi.mock("@utils/hostedApi", () => ({
  workspaceTree: vi.fn(),
}));

const workspaceTreeMock = vi.mocked(workspaceTree);

function mockTree(dirPath: string): Promise<WorkspaceTreeResponse> {
  if (dirPath === "src") {
    return Promise.resolve({
      rootLabel: "workspace",
      path: "src",
      parentPath: "",
      entries: [{ name: "index.ts", path: "src/index.ts", kind: "file" }],
      isGitRepo: false,
      isRootsList: false,
    });
  }
  return Promise.resolve({
    rootLabel: "workspace",
    path: "",
    parentPath: null,
    entries: [
      { name: "src", path: "src", kind: "directory" },
      { name: "readme.md", path: "readme.md", kind: "file" },
      { name: "image.png", path: "image.png", kind: "file" },
    ],
    isGitRepo: false,
    isRootsList: false,
  });
}

beforeEach(() => {
  workspaceTreeMock.mockReset();
  workspaceTreeMock.mockImplementation((dirPath: string) => mockTree(dirPath));
  useUiStore.setState({
    fileBrowserState: null,
    fileBrowserLastDirectory: null,
  });
});

describe("FileBrowserModal — visibility", () => {
  it("renders nothing when fileBrowserState is null", () => {
    render(<FileBrowserModal />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("loads the initial directory and lists its entries when opened", async () => {
    useUiStore.getState().openFileBrowser({ mode: "file", onSelect: vi.fn() });
    render(<FileBrowserModal />);

    await waitFor(() => expect(workspaceTreeMock).toHaveBeenCalledWith(""));
    expect(await screen.findByText("readme.md")).toBeInTheDocument();
    expect(screen.getByText("src/")).toBeInTheDocument();
  });
});

describe("FileBrowserModal — navigation", () => {
  it("navigates into a folder on click", async () => {
    const user = userEvent.setup();
    useUiStore.getState().openFileBrowser({ mode: "file", onSelect: vi.fn() });
    render(<FileBrowserModal />);

    const folderRow = await screen.findByText("src/");
    await user.click(folderRow);

    await waitFor(() => expect(workspaceTreeMock).toHaveBeenCalledWith("src"));
    expect(await screen.findByText("index.ts")).toBeInTheDocument();
  });

  it("reopens in the directory used for the previous selection", async () => {
    const user = userEvent.setup();
    useUiStore.getState().openFileBrowser({ mode: "file", onSelect: vi.fn() });
    render(<FileBrowserModal />);

    await user.click(await screen.findByText("src/"));
    await user.click(await screen.findByText("index.ts"));
    await user.click(screen.getByRole("button", { name: "Select File" }));

    expect(useUiStore.getState().fileBrowserLastDirectory).toBe("src");
    workspaceTreeMock.mockClear();

    act(() => {
      useUiStore
        .getState()
        .openFileBrowser({ mode: "file", onSelect: vi.fn() });
    });

    await waitFor(() => expect(workspaceTreeMock).toHaveBeenCalledWith("src"));
    expect(await screen.findByText("index.ts")).toBeInTheDocument();
  });

  it("falls back to the workspace root when the remembered directory is stale", async () => {
    useUiStore.setState({ fileBrowserLastDirectory: "deleted" });
    workspaceTreeMock.mockImplementation((dirPath: string) => {
      if (dirPath === "deleted") {
        return Promise.reject(new Error("Directory not found"));
      }
      return mockTree(dirPath);
    });
    useUiStore.getState().openFileBrowser({ mode: "file", onSelect: vi.fn() });

    render(<FileBrowserModal />);

    await waitFor(() => {
      expect(workspaceTreeMock.mock.calls.map(([path]) => path)).toEqual([
        "deleted",
        "",
      ]);
    });
    expect(await screen.findByText("readme.md")).toBeInTheDocument();
  });
});

describe("FileBrowserModal — file mode", () => {
  it("selects a matching file, enabling confirm, and confirming selects it and closes", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    useUiStore.getState().openFileBrowser({
      mode: "file",
      fileFilter: ["**/*.md"],
      onSelect,
    });
    render(<FileBrowserModal />);

    const fileRow = await screen.findByText("readme.md");
    const confirmButton = screen.getByRole("button", { name: "Select File" });
    expect(confirmButton).toBeDisabled();

    await user.click(fileRow);
    expect(confirmButton).not.toBeDisabled();

    await user.click(confirmButton);

    expect(onSelect).toHaveBeenCalledWith("readme.md");
    expect(useUiStore.getState().fileBrowserState).toBeNull();
  });

  it("dims non-matching files per fileFilter and does not let them be selected", async () => {
    const user = userEvent.setup();
    useUiStore.getState().openFileBrowser({
      mode: "file",
      fileFilter: ["**/*.md"],
      onSelect: vi.fn(),
    });
    render(<FileBrowserModal />);

    const nonMatchingRow = await screen.findByText("image.png");
    await user.click(nonMatchingRow);

    expect(screen.getByRole("button", { name: "Select File" })).toBeDisabled();
  });
});

describe("FileBrowserModal — directory mode", () => {
  it("confirms the current directory without requiring a selection", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    useUiStore.getState().openFileBrowser({ mode: "directory", onSelect });
    render(<FileBrowserModal />);

    await screen.findByText("readme.md");
    const confirmButton = screen.getByRole("button", {
      name: "Select Folder",
    });
    expect(confirmButton).not.toBeDisabled();

    await user.click(confirmButton);

    expect(onSelect).toHaveBeenCalledWith("");
    expect(useUiStore.getState().fileBrowserState).toBeNull();
  });

  it("navigates into a folder and confirms that folder as the target", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    useUiStore.getState().openFileBrowser({ mode: "directory", onSelect });
    render(<FileBrowserModal />);

    const folderRow = await screen.findByText("src/");
    await user.click(folderRow);
    await waitFor(() => expect(workspaceTreeMock).toHaveBeenCalledWith("src"));

    const confirmButton = await screen.findByRole("button", {
      name: "Select Folder",
    });
    await user.click(confirmButton);

    expect(onSelect).toHaveBeenCalledWith("src");
  });
});

describe("FileBrowserModal — cancel", () => {
  it("closes without calling onSelect", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    useUiStore.getState().openFileBrowser({ mode: "file", onSelect });
    render(<FileBrowserModal />);

    await screen.findByText("readme.md");
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onSelect).not.toHaveBeenCalled();
    expect(useUiStore.getState().fileBrowserState).toBeNull();
  });
});
