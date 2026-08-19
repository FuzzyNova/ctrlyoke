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
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceExplorerPane } from "@components/workspace-viewer/WorkspaceExplorerPane";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";
import { useSettingsStore } from "@store/settingsStore";

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
    entries: [],
    path: "",
    parentPath: null,
    rootLabel: "workspace",
    isGitRepo: false,
  }),
  workspaceFile: vi.fn().mockResolvedValue({ content: "", path: "" }),
  workspaceSaveFile: vi.fn().mockResolvedValue(undefined),
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

  it("opens the Search tab from the directory toolbar", async () => {
    const user = userEvent.setup();
    render(<WorkspaceExplorerPane />);

    const searchButton = screen.getByRole("button", {
      name: "Search workspace",
    });
    expect(searchButton).toBeInTheDocument();

    await user.click(searchButton);

    expect(useWorkspaceViewerStore.getState().activeTab).toBe("search");
  });
});
