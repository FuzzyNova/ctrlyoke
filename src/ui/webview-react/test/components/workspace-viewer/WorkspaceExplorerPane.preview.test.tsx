/**
 * Tests for the markdown preview toggle in WorkspaceExplorerPane.
 *
 * The "Preview" button appears in the file toolbar only for markdown files and
 * swaps the CodeMirror editor for a rendered MarkdownText view (and back).
 *
 * Strategy: stub the heavy editor + markdown renderer and the hosted API so the
 * pane mounts without network/CodeMirror, preset store state to simulate an
 * already-open file, render, and assert the toggle behaviour.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceExplorerPane } from "@components/workspace-viewer/WorkspaceExplorerPane";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";
import { useSettingsStore } from "@store/settingsStore";
import { useUiStore } from "@store/uiStore";
import { workspaceFile } from "@utils/hostedApi";
import { HOSTED_WORKSPACE_FILE_CHANGED_EVENT } from "@root/types/DashboardConstants";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// Stub CodeMirror editor — render a marker so we can assert its presence and
// expose the imperative handle shape the pane wires up.
vi.mock("@components/workspace-viewer/WorkspaceFileEditor", () => ({
  WorkspaceFileEditor: () => <div data-testid="file-editor">EDITOR</div>,
}));

// Stub the markdown renderer so we can assert it receives the file content
// without pulling in the full Streamdown pipeline.
vi.mock("@components/output/MarkdownText", () => ({
  MarkdownText: ({
    children,
    tableFullscreen,
  }: {
    children: string;
    tableFullscreen?: boolean;
  }) => (
    <div
      data-testid="markdown-preview"
      data-table-fullscreen={String(tableFullscreen)}
    >
      {children}
    </div>
  ),
}));

// Pane loads the directory + git status on mount; resolve them to empty.
vi.mock("@utils/hostedApi", () => ({
  workspaceTree: vi.fn().mockResolvedValue({
    listingId: "preview-listing",
    pageSize: 100,
    entries: [],
    path: "",
    parentPath: null,
    rootLabel: "workspace",
    isGitRepo: false,
    isRootsList: false,
    totalEntries: 0,
    offset: 0,
  }),
  workspaceFile: vi.fn().mockResolvedValue({
    content: "",
    path: "",
    modifiedAt: 1,
  }),
  workspaceFileWatch: vi.fn().mockResolvedValue(undefined),
  workspaceSaveFile: vi.fn().mockResolvedValue({ modifiedAt: 2 }),
  workspaceStatus: vi.fn().mockResolvedValue({ files: [] }),
}));

vi.mock("@hooks/useVsCodeApi", () => ({
  useVsCodeApi: () => ({ postMessage: vi.fn() }),
}));

// Force desktop layout so both the toolbar and editor column render together.
vi.mock("@hooks/useMediaQuery", () => ({
  useIsMobile: () => false,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function openFileInStore(path: string, content: string) {
  useWorkspaceViewerStore.getState().selectFile(path);
  useWorkspaceViewerStore.getState().setLoadedFileContent(path, content);
}

beforeEach(() => {
  useWorkspaceViewerStore.getState().reset();
  useSettingsStore.getState().updateGlobalSetting("workspaceRoot", "");
  useUiStore.getState().setMyClientId("browser:current");
  vi.mocked(workspaceFile).mockResolvedValue({
    content: "external content",
    path: "docs/readme.md",
    modifiedAt: 2,
    name: "readme.md",
    size: 16,
    eol: "lf",
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WorkspaceExplorerPane — markdown preview toggle", () => {
  it("shows the Preview button for markdown files", () => {
    openFileInStore("docs/readme.md", "# Hello");
    render(<WorkspaceExplorerPane />);

    expect(
      screen.getByRole("button", { name: /preview/i })
    ).toBeInTheDocument();
  });

  it("does not show the Preview button for non-markdown files", () => {
    openFileInStore("src/index.ts", "const a = 1;");
    render(<WorkspaceExplorerPane />);

    expect(
      screen.queryByRole("button", { name: /preview/i })
    ).not.toBeInTheDocument();
  });

  it("renders the markdown preview and hides the editor when toggled on", async () => {
    const user = userEvent.setup();
    openFileInStore("docs/readme.md", "# Hello");
    render(<WorkspaceExplorerPane />);

    await user.click(screen.getByRole("button", { name: /preview/i }));

    const preview = screen.getByTestId("markdown-preview");
    expect(preview).toHaveTextContent("# Hello");

    // Editor stays mounted (so undo history survives) but is visually hidden.
    const editorWrapper = screen.getByTestId("file-editor").parentElement;
    expect(editorWrapper).toHaveClass("hidden");
    expect(editorWrapper).toHaveClass("w-full", "min-w-0");

    // Button now offers a way back to the editor.
    expect(screen.getByRole("button", { name: /edit/i })).toBeInTheDocument();

    // The preview disables streamdown's table fullscreen control, whose overlay
    // portals to document.body and doesn't surface from this pane.
    expect(preview).toHaveAttribute("data-table-fullscreen", "false");
  });

  it("returns to the editor when toggled back off", async () => {
    const user = userEvent.setup();
    openFileInStore("docs/readme.md", "# Hello");
    render(<WorkspaceExplorerPane />);

    await user.click(screen.getByRole("button", { name: /preview/i }));
    await user.click(screen.getByRole("button", { name: /edit/i }));

    expect(screen.queryByTestId("markdown-preview")).not.toBeInTheDocument();
    const editorWrapper = screen.getByTestId("file-editor").parentElement;
    expect(editorWrapper).not.toHaveClass("hidden");
  });
});

describe("WorkspaceExplorerPane — external file changes", () => {
  it("reloads a clean editor without showing the conflict banner", async () => {
    openFileInStore("docs/readme.md", "old content");
    render(<WorkspaceExplorerPane />);

    act(() => {
      window.dispatchEvent(
        new CustomEvent(HOSTED_WORKSPACE_FILE_CHANGED_EVENT, {
          detail: { path: "docs/readme.md", modifiedAt: 2 },
        })
      );
    });

    await waitFor(() => {
      expect(useWorkspaceViewerStore.getState().fileContent).toBe(
        "external content"
      );
    });
    expect(
      screen.queryByText("This file changed on disk.")
    ).not.toBeInTheDocument();
  });

  it("shows Reload, Compare, and Keep mine for a dirty editor", () => {
    openFileInStore("docs/readme.md", "old content");
    useWorkspaceViewerStore.getState().setFileContent("my unsaved content");
    render(<WorkspaceExplorerPane />);

    act(() => {
      window.dispatchEvent(
        new CustomEvent(HOSTED_WORKSPACE_FILE_CHANGED_EVENT, {
          detail: { path: "docs/readme.md", modifiedAt: 2 },
        })
      );
    });

    expect(screen.getByText("This file changed on disk.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Compare" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Keep mine" })
    ).toBeInTheDocument();
    expect(useWorkspaceViewerStore.getState().fileContent).toBe(
      "my unsaved content"
    );
  });
});
