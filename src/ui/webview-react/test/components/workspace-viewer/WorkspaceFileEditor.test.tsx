import { createRef } from "react";
import { render, fireEvent, waitFor, screen } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WorkspaceFileEditor,
  type WorkspaceFileEditorHandle,
} from "@components/workspace-viewer/WorkspaceFileEditor";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";
import { act } from "react";
import { useUiStore } from "@store/uiStore";
import { useSettingsStore } from "@store/settingsStore";
import { WORKSPACE_ENTRY_KINDS } from "@root/types/DashboardConstants";
import { EditorView } from "codemirror";
import { EditorSelection } from "@codemirror/state";

vi.mock("@components/workspace-viewer/WorkspacePdfViewer", () => ({
  WorkspacePdfViewer: ({ rawUrl }: { rawUrl: string }) => (
    <div data-testid="workspace-pdf-viewer">
      <a href={rawUrl} target="_blank" rel="noreferrer">
        Open in new tab
      </a>
    </div>
  ),
}));

describe("WorkspaceFileEditor link navigation", () => {
  beforeAll(() => {
    if (!Range.prototype.getClientRects) {
      Object.defineProperty(Range.prototype, "getClientRects", {
        configurable: true,
        value: () => [],
      });
    }
  });

  beforeEach(() => {
    useWorkspaceViewerStore.getState().reset();
    useUiStore.setState({ globalSettingsOpen: false });
  });

  it("decorates and opens secret references in the Secrets settings page", async () => {
    const { container } = render(
      <WorkspaceFileEditor
        filePath="notes.prompt.md"
        content="Use !SERVICE_TOKEN here"
        onChange={vi.fn()}
        onSave={vi.fn()}
      />
    );

    const link = await waitFor(() => {
      const el = container.querySelector(".cm-link");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(link).toHaveAttribute("data-type", "secret");
    expect(link).toHaveAttribute("data-secret-name", "SERVICE_TOKEN");

    fireEvent.touchStart(link, {
      touches: [{ clientX: 10, clientY: 10 }],
    });
    fireEvent.touchEnd(link);

    expect(useUiStore.getState().globalSettingsOpen).toBe(true);
    expect(useUiStore.getState().globalSettingsActiveTab).toBe("secrets");
  });

  it("opens #selection links with the selected line range on touch tap", async () => {
    const onChange = vi.fn();
    const onSave = vi.fn();

    const { container } = render(
      <WorkspaceFileEditor
        filePath="notes.prompt.md"
        content={'Check #selection:"src/app.ts":10-20'}
        onChange={onChange}
        onSave={onSave}
      />
    );

    const link = await waitFor(() => {
      const el = container.querySelector(".cm-link");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });

    fireEvent.touchStart(link, {
      touches: [{ clientX: 10, clientY: 10 }],
    });
    fireEvent.touchEnd(link);

    const nav = useWorkspaceViewerStore.getState().pendingNavigation;
    expect(nav).not.toBeNull();
    expect(nav?.type).toBe(WORKSPACE_ENTRY_KINDS.FILE);
    if (nav?.type === WORKSPACE_ENTRY_KINDS.FILE) {
      expect(nav.filePath).toBe("src/app.ts");
      expect(nav.startLine).toBe(10);
      expect(nav.endLine).toBe(20);
    }
  });

  it("keeps Ctrl-click on a .cm-link as reference navigation", async () => {
    const { container } = render(
      <WorkspaceFileEditor
        filePath="notes.prompt.md"
        content={'Check #selection:"src/app.ts":10-12'}
        onChange={vi.fn()}
        onSave={vi.fn()}
      />
    );
    const link = await waitFor(() => {
      const element = container.querySelector(".cm-link");
      expect(element).not.toBeNull();
      return element as HTMLElement;
    });
    fireEvent.click(link, { ctrlKey: true, clientX: 1, clientY: 1 });
    expect(useWorkspaceViewerStore.getState().pendingNavigation).toMatchObject({
      type: "file",
      filePath: "src/app.ts",
      startLine: 10,
      endLine: 12,
    });
  });

  it("opens #sym links at the symbol range on touch tap", async () => {
    const onChange = vi.fn();
    const onSave = vi.fn();

    const { container } = render(
      <WorkspaceFileEditor
        filePath="notes.prompt.md"
        content="#sym:src/utils.ts:runWorkflow:42-58"
        onChange={onChange}
        onSave={onSave}
      />
    );

    const link = await waitFor(() => {
      const el = container.querySelector(".cm-link");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });

    fireEvent.touchStart(link, {
      touches: [{ clientX: 10, clientY: 10 }],
    });
    fireEvent.touchEnd(link);

    const nav = useWorkspaceViewerStore.getState().pendingNavigation;
    expect(nav).not.toBeNull();
    expect(nav?.type).toBe(WORKSPACE_ENTRY_KINDS.FILE);
    if (nav?.type === WORKSPACE_ENTRY_KINDS.FILE) {
      expect(nav.filePath).toBe("src/utils.ts");
      expect(nav.startLine).toBe(42);
      expect(nav.endLine).toBe(58);
    }
  });

  it("opens a kinded #sym link with a quoted path and name", async () => {
    const onChange = vi.fn();
    const onSave = vi.fn();

    const { container } = render(
      <WorkspaceFileEditor
        filePath="notes.prompt.md"
        content={'#sym.type-parameter:"src/my utils.ts":"get value":42-58'}
        onChange={onChange}
        onSave={onSave}
      />
    );

    const link = await waitFor(() => {
      const el = container.querySelector(".cm-link");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });

    fireEvent.touchStart(link, {
      touches: [{ clientX: 10, clientY: 10 }],
    });
    fireEvent.touchEnd(link);

    const nav = useWorkspaceViewerStore.getState().pendingNavigation;
    expect(nav?.type).toBe(WORKSPACE_ENTRY_KINDS.FILE);
    if (nav?.type === WORKSPACE_ENTRY_KINDS.FILE) {
      expect(nav.filePath).toBe("src/my utils.ts");
      expect(nav.startLine).toBe(42);
      expect(nav.endLine).toBe(58);
    }
  });

  it("follows ui.wordWrap without rebuilding the editor", () => {
    useSettingsStore.getState().updateGlobalSetting("wordWrap", true);
    const { container } = render(
      <WorkspaceFileEditor
        filePath="src/a.ts"
        content="const a = 1;"
        onChange={vi.fn()}
        onSave={vi.fn()}
      />
    );
    const editor = container.querySelector(".cm-content");
    expect(editor).toHaveClass("cm-lineWrapping");

    act(() => {
      useSettingsStore.getState().updateGlobalSetting("wordWrap", false);
    });
    expect(container.querySelector(".cm-content")).toBe(editor);
    expect(editor).not.toHaveClass("cm-lineWrapping");

    act(() => {
      useSettingsStore.getState().updateGlobalSetting("wordWrap", true);
    });
    expect(editor).toHaveClass("cm-lineWrapping");
  });

  it("renders an <img> instead of the editor for a known image type", () => {
    const onChange = vi.fn();
    const onSave = vi.fn();
    const rawUrl = "/api/workspace-viewer/raw?path=image.png&token=test";

    const { container } = render(
      <WorkspaceFileEditor
        filePath=".ctrlyoke/attachments/pasted-image-abc.png"
        content=""
        media={{ kind: "image", rawUrl }}
        onChange={onChange}
        onSave={onSave}
      />
    );

    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute("src", rawUrl);
    // No CodeMirror editor is created for an image.
    expect(container.querySelector(".cm-editor")).toBeNull();
  });

  it.each([["video", "video"] as const, ["audio", "audio"] as const])(
    "renders a raw %s element",
    (kind, tagName) => {
      const rawUrl = `/api/workspace-viewer/raw?path=media.${kind}&v=42&token=test`;
      const { container } = render(
        <WorkspaceFileEditor
          filePath={`media.${kind}`}
          content=""
          media={{ kind, rawUrl }}
          onChange={vi.fn()}
          onSave={vi.fn()}
        />
      );
      const player = container.querySelector(tagName);
      expect(player).toHaveAttribute("src", rawUrl);
      expect(player).toHaveAttribute("preload", "metadata");
      if (kind === "video") expect(player).toHaveAttribute("playsinline");
      expect(player).toHaveAttribute("controls");
      expect(container.querySelector(".cm-editor")).toBeNull();
    }
  );

  it("renders the PDF viewer for PDF media", () => {
    const rawUrl =
      "/api/workspace-viewer/raw?path=docs%2Fmanual.pdf&token=test";
    render(
      <WorkspaceFileEditor
        filePath="docs/manual.pdf"
        content=""
        media={{ kind: "pdf", rawUrl }}
        onChange={vi.fn()}
        onSave={vi.fn()}
      />
    );

    expect(
      screen.getByRole("link", { name: "Open in new tab" })
    ).toHaveAttribute("href", rawUrl);
    expect(screen.getByTestId("workspace-pdf-viewer")).toBeInTheDocument();
    expect(screen.queryByText("PDF preview")).not.toBeInTheDocument();
  });

  it("shows playback fallback links on error and resets them when the URL changes", () => {
    const firstUrl = "/api/workspace-viewer/raw?path=movie.mp4&v=1";
    const nextUrl = "/api/workspace-viewer/raw?path=movie.mp4&v=2";
    const props = {
      filePath: "movie.mp4",
      content: "",
      onChange: vi.fn(),
      onSave: vi.fn(),
    };
    const { container, rerender } = render(
      <WorkspaceFileEditor
        {...props}
        media={{ kind: "video", rawUrl: firstUrl }}
      />
    );

    fireEvent.error(container.querySelector("video") as HTMLVideoElement);
    expect(screen.getByRole("status")).toHaveTextContent(
      "This browser can't play this file"
    );
    const openLink = screen.getByRole("link", { name: "Open in new tab" });
    expect(openLink).toHaveAttribute("href", firstUrl);
    expect(openLink).toHaveAttribute("target", "_blank");
    expect(openLink).toHaveAttribute("rel", "noopener");
    expect(screen.getByRole("link", { name: "Download" })).toHaveAttribute(
      "download"
    );

    rerender(
      <WorkspaceFileEditor
        {...props}
        media={{ kind: "video", rawUrl: nextUrl }}
      />
    );
    expect(container.querySelector("video")).toHaveAttribute("src", nextUrl);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("shows an image-specific fallback when an image fails to load", () => {
    const rawUrl = "/api/workspace-viewer/raw?path=broken.png&v=3";
    const { container } = render(
      <WorkspaceFileEditor
        filePath="broken.png"
        content=""
        media={{ kind: "image", rawUrl }}
        onChange={vi.fn()}
        onSave={vi.fn()}
      />
    );
    fireEvent.error(container.querySelector("img") as HTMLImageElement);
    expect(screen.getByRole("status")).toHaveTextContent(
      "This image can't be displayed"
    );
    expect(
      screen.getByRole("link", { name: "Open in new tab" })
    ).toHaveAttribute("href", rawUrl);
    expect(screen.getByRole("link", { name: "Download" })).toHaveAttribute(
      "href",
      rawUrl
    );
  });

  it("applies a pending selection request inside CodeMirror", async () => {
    const editorRef = createRef<WorkspaceFileEditorHandle>();
    const onChange = vi.fn();
    const onSave = vi.fn();
    const onPendingSelectionApplied = vi.fn();

    render(
      <WorkspaceFileEditor
        ref={editorRef}
        filePath="src/app.ts"
        content={["line 1", "line 2", "line 3", "line 4"].join("\n")}
        onChange={onChange}
        onSave={onSave}
        pendingSelection={{ requestId: 7, startLine: 2, endLine: 3 }}
        onPendingSelectionApplied={onPendingSelectionApplied}
      />
    );

    await waitFor(() => {
      expect(editorRef.current?.getSelectionRange()).toEqual({
        startLine: 2,
        endLine: 3,
      });
    });
    expect(onPendingSelectionApplied).toHaveBeenCalledWith(7);
  });

  it("uses an inclusive end line for a whole-line CodeMirror selection", () => {
    const editorRef = createRef<WorkspaceFileEditorHandle>();
    const { container } = render(
      <WorkspaceFileEditor
        ref={editorRef}
        filePath="src/app.ts"
        content={["line 1", "line 2", "line 3"].join("\n")}
        onChange={vi.fn()}
        onSave={vi.fn()}
      />
    );

    const editor = container.querySelector(".cm-content");
    expect(editor).not.toBeNull();
    const view = EditorView.findFromDOM(editor as HTMLElement);
    expect(view).not.toBeNull();
    const doc = view!.state.doc;
    act(() => {
      view!.dispatch({
        selection: EditorSelection.range(doc.line(2).from, doc.line(3).from),
      });
    });

    expect(editorRef.current?.getSelectionRange()).toEqual({
      startLine: 2,
      endLine: 2,
    });
    expect(editorRef.current?.getSelectionText()).toBe("line 2\n");
  });
});
