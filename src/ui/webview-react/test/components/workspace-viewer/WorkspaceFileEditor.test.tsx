import { createRef } from "react";
import { render, fireEvent, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WorkspaceFileEditor,
  type WorkspaceFileEditorHandle,
} from "@components/workspace-viewer/WorkspaceFileEditor";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";

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
    expect(nav?.type).toBe("file");
    if (nav?.type === "file") {
      expect(nav.filePath).toBe("src/app.ts");
      expect(nav.startLine).toBe(10);
      expect(nav.endLine).toBe(20);
    }
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
    expect(nav?.type).toBe("file");
    if (nav?.type === "file") {
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
    expect(nav?.type).toBe("file");
    if (nav?.type === "file") {
      expect(nav.filePath).toBe("src/my utils.ts");
      expect(nav.startLine).toBe(42);
      expect(nav.endLine).toBe(58);
    }
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
