/**
 * Tests for WorkspaceViewerModal.
 *
 * WorkspaceViewerModal depends on:
 *   - workspaceViewerStore (isOpen, activeTab, fileDirty, etc.)
 *   - WorkspaceExplorerPane (pane sub-component — stubbed)
 *   - WorkspaceSourceControlPane (pane sub-component — stubbed)
 *   - WorkspaceViewerHeader (header with tab buttons + close)
 *
 * Strategy: stub all heavy sub-components and hostedApi, preset store state,
 * render, and assert modal visibility / tab switching / close-guard behavior.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceViewerModal } from "@components/workspace-viewer/WorkspaceViewerModal";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// Stub both content panes so they don't kick off API calls on mount.
vi.mock("@components/workspace-viewer/WorkspaceExplorerPane", () => ({
  WorkspaceExplorerPane: () => (
    <div data-testid="explorer-pane">ExplorerPane</div>
  ),
}));

vi.mock("@components/workspace-viewer/WorkspaceSourceControlPane", () => ({
  WorkspaceSourceControlPane: () => (
    <div data-testid="source-control-pane">SourceControlPane</div>
  ),
}));

// ---------------------------------------------------------------------------
// Store reset
// ---------------------------------------------------------------------------

beforeEach(() => {
  useWorkspaceViewerStore.getState().close();
});

// ---------------------------------------------------------------------------
// Visibility
// ---------------------------------------------------------------------------

describe("WorkspaceViewerModal — visibility", () => {
  it("renders nothing when isOpen is false", () => {
    render(<WorkspaceViewerModal />);

    expect(screen.queryByText("FlightPath Workspace")).not.toBeInTheDocument();
  });

  it("renders the modal when isOpen is true", () => {
    useWorkspaceViewerStore.setState({ isOpen: true });
    render(<WorkspaceViewerModal />);

    expect(screen.getByTestId("workspace-name")).toBeInTheDocument();
  });

  it("shows the explorer pane by default", () => {
    useWorkspaceViewerStore.setState({ isOpen: true });
    render(<WorkspaceViewerModal />);

    expect(screen.getByTestId("explorer-pane")).toBeInTheDocument();
    expect(screen.queryByTestId("source-control-pane")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Tab switching
// ---------------------------------------------------------------------------

describe("WorkspaceViewerModal — tabs", () => {
  it("switches to the Source Control pane when tab is clicked", async () => {
    const user = userEvent.setup();
    useWorkspaceViewerStore.setState({ isOpen: true });
    render(<WorkspaceViewerModal />);

    const scTab = screen.getByRole("tab", { name: /source control/i });
    await user.click(scTab);

    expect(screen.getByTestId("source-control-pane")).toBeInTheDocument();
    expect(screen.queryByTestId("explorer-pane")).not.toBeInTheDocument();
  });

  it("switches back to explorer pane when Explorer tab is clicked", async () => {
    const user = userEvent.setup();
    useWorkspaceViewerStore.setState({
      isOpen: true,
      activeTab: "sourceControl",
    });
    render(<WorkspaceViewerModal />);

    const explorerTab = screen.getByRole("tab", { name: /explorer/i });
    await user.click(explorerTab);

    expect(screen.getByTestId("explorer-pane")).toBeInTheDocument();
    expect(screen.queryByTestId("source-control-pane")).not.toBeInTheDocument();
  });

  it("marks the active tab with aria-selected=true", () => {
    useWorkspaceViewerStore.setState({
      isOpen: true,
      activeTab: "sourceControl",
    });
    render(<WorkspaceViewerModal />);

    const scTab = screen.getByRole("tab", { name: /source control/i });
    const explorerTab = screen.getByRole("tab", { name: /explorer/i });
    expect(scTab).toHaveAttribute("aria-selected", "true");
    expect(explorerTab).toHaveAttribute("aria-selected", "false");
  });
});

// ---------------------------------------------------------------------------
// Close button — clean file
// ---------------------------------------------------------------------------

describe("WorkspaceViewerModal — close (no dirty file)", () => {
  it("closes the modal when close button is clicked without a dirty file", async () => {
    const user = userEvent.setup();
    useWorkspaceViewerStore.setState({ isOpen: true, fileDirty: false });
    render(<WorkspaceViewerModal />);

    await user.click(
      screen.getByRole("button", { name: /close workspace viewer/i })
    );

    expect(useWorkspaceViewerStore.getState().isOpen).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Close button — dirty file triggers guard
// ---------------------------------------------------------------------------

describe("WorkspaceViewerModal — close (dirty file)", () => {
  it("does not close immediately when there is a dirty file", async () => {
    const user = userEvent.setup();
    useWorkspaceViewerStore.setState({
      isOpen: true,
      fileDirty: true,
      selectedFilePath: "src/index.ts",
      fileContent: "changed",
      originalFileContent: "original",
    });
    render(<WorkspaceViewerModal />);

    await user.click(
      screen.getByRole("button", { name: /close workspace viewer/i })
    );

    // Modal is still open — dirty guard should have fired instead
    expect(useWorkspaceViewerStore.getState().isOpen).toBe(true);
    expect(useWorkspaceViewerStore.getState().dirtyExitPending).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// workspaceViewerStore — state management
// ---------------------------------------------------------------------------

describe("workspaceViewerStore — dirty exit guard actions", () => {
  it("promptDirtyExit sets dirtyExitPending=true and stores the action", () => {
    const action = vi.fn();
    useWorkspaceViewerStore.getState().promptDirtyExit(action);

    const state = useWorkspaceViewerStore.getState();
    expect(state.dirtyExitPending).toBe(true);
    expect(state.dirtyExitAction).toBe(action);
  });

  it("confirmDirtyExit clears state and calls the stored action", () => {
    const action = vi.fn();
    useWorkspaceViewerStore.setState({
      dirtyExitPending: true,
      dirtyExitAction: action,
    });

    useWorkspaceViewerStore.getState().confirmDirtyExit();

    expect(action).toHaveBeenCalledOnce();
    expect(useWorkspaceViewerStore.getState().dirtyExitPending).toBe(false);
    expect(useWorkspaceViewerStore.getState().dirtyExitAction).toBeNull();
  });

  it("cancelDirtyExit clears state without calling the action", () => {
    const action = vi.fn();
    useWorkspaceViewerStore.setState({
      dirtyExitPending: true,
      dirtyExitAction: action,
    });

    useWorkspaceViewerStore.getState().cancelDirtyExit();

    expect(action).not.toHaveBeenCalled();
    expect(useWorkspaceViewerStore.getState().dirtyExitPending).toBe(false);
  });
});

describe("workspaceViewerStore — file read-only state", () => {
  it("setFileReadOnly(true) sets fileReadOnly and reason", () => {
    useWorkspaceViewerStore.getState().setFileReadOnly(true, "Binary file");

    const state = useWorkspaceViewerStore.getState();
    expect(state.fileReadOnly).toBe(true);
    expect(state.fileReadOnlyReason).toBe("Binary file");
  });

  it("setFileReadOnly(false) clears fileReadOnlyReason", () => {
    useWorkspaceViewerStore.setState({
      fileReadOnly: true,
      fileReadOnlyReason: "Binary file",
    });

    useWorkspaceViewerStore.getState().setFileReadOnly(false);

    expect(useWorkspaceViewerStore.getState().fileReadOnly).toBe(false);
    expect(
      useWorkspaceViewerStore.getState().fileReadOnlyReason
    ).toBeUndefined();
  });

  it("selectFile resets fileReadOnly state", () => {
    useWorkspaceViewerStore.setState({
      fileReadOnly: true,
      fileReadOnlyReason: "Path not allowed",
    });

    useWorkspaceViewerStore.getState().selectFile("src/index.ts");

    expect(useWorkspaceViewerStore.getState().fileReadOnly).toBe(false);
    expect(
      useWorkspaceViewerStore.getState().fileReadOnlyReason
    ).toBeUndefined();
  });

  it("clearFile resets fileReadOnly state", () => {
    useWorkspaceViewerStore.setState({
      fileReadOnly: true,
      fileReadOnlyReason: "File not found",
    });

    useWorkspaceViewerStore.getState().clearFile();

    expect(useWorkspaceViewerStore.getState().fileReadOnly).toBe(false);
    expect(
      useWorkspaceViewerStore.getState().fileReadOnlyReason
    ).toBeUndefined();
  });
});

describe("workspaceViewerStore — save state", () => {
  it("markFileSaved clears dirty state after a successful save", () => {
    useWorkspaceViewerStore.setState({
      fileContent: "updated",
      originalFileContent: "original",
      fileDirty: true,
    });

    useWorkspaceViewerStore.getState().markFileSaved();

    const state = useWorkspaceViewerStore.getState();
    expect(state.fileContent).toBe("updated");
    expect(state.originalFileContent).toBe("updated");
    expect(state.fileDirty).toBe(false);
  });
});

describe("workspaceViewerStore — diff state", () => {
  it("clearDiff resets the selected diff and payload", () => {
    useWorkspaceViewerStore.setState({
      selectedDiffPath: "src/fileA.ts",
      diffOldContent: "before",
      diffNewContent: "after",
      diffLanguage: "typescript",
      diffKind: "modified",
      diffLoading: true,
    });

    useWorkspaceViewerStore.getState().clearDiff();

    const state = useWorkspaceViewerStore.getState();
    expect(state.selectedDiffPath).toBeNull();
    expect(state.diffOldContent).toBe("");
    expect(state.diffNewContent).toBe("");
    expect(state.diffLanguage).toBeUndefined();
    expect(state.diffKind).toBeNull();
    expect(state.diffLoading).toBe(false);
  });

  it("setSourceControlFiles clears the diff when the selected file disappears", () => {
    useWorkspaceViewerStore.setState({
      selectedDiffPath: "src/fileA.ts",
      diffOldContent: "before",
      diffNewContent: "after",
      diffLanguage: "typescript",
      diffKind: "modified",
    });

    useWorkspaceViewerStore.getState().setSourceControlFiles([
      {
        path: "src/fileB.ts",
        stagedStatus: "M",
        unstagedStatus: null,
        kind: "modified",
      },
    ]);

    const state = useWorkspaceViewerStore.getState();
    expect(state.selectedDiffPath).toBeNull();
    expect(state.diffOldContent).toBe("");
    expect(state.diffNewContent).toBe("");
    expect(state.diffLanguage).toBeUndefined();
    expect(state.diffKind).toBeNull();
  });
});
