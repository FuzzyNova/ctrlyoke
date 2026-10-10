import { createRef } from "react";
import { render, fireEvent, waitFor } from "@testing-library/react";
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
    const dataUri = "data:image/png;base64,AAAA";

    const { container } = render(
      <WorkspaceFileEditor
        filePath=".ctrlyoke/attachments/pasted-image-abc.png"
        content=""
        imageDataUri={dataUri}
        onChange={onChange}
        onSave={onSave}
      />
    );

    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute("src", dataUri);
    // No CodeMirror editor is created for an image.
    expect(container.querySelector(".cm-editor")).toBeNull();
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
});
