import { createRef } from "react";
import { render, waitFor } from "@testing-library/react";
import { StateField } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WorkspaceFileEditor,
  type WorkspaceFileEditorHandle,
} from "@components/workspace-viewer/WorkspaceFileEditor";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";

const { useLanguageIntelligenceMock } = vi.hoisted(() => ({
  useLanguageIntelligenceMock: vi.fn(() => ({
    filePath: "src/app.ts",
    extensions: [] as Extension[],
    sessionId: null as string | null,
    capabilities: {},
  })),
}));

vi.mock("@hooks/useLanguageIntelligence", () => ({
  useLanguageIntelligence: useLanguageIntelligenceMock,
}));

describe("WorkspaceFileEditor language intelligence compartment", () => {
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
    useLanguageIntelligenceMock.mockReturnValue({
      filePath: "src/app.ts",
      extensions: [],
      sessionId: null,
      capabilities: {},
    });
  });

  it("reconfigures a connected session without replacing the editor view", async () => {
    const ref = createRef<WorkspaceFileEditorHandle>();
    const props = {
      filePath: "src/app.ts",
      content: "first line\nsecond line\nthird line",
      onChange: vi.fn(),
      onSave: vi.fn(),
    };
    const { container, rerender } = render(
      <WorkspaceFileEditor ref={ref} {...props} />
    );
    const content = container.querySelector(".cm-content");
    ref.current?.selectLines(2, 3);
    const selection = ref.current?.getSelectionRange();
    expect(selection).toEqual({ startLine: 2, endLine: 3 });

    const sessionExtension = StateField.define({
      create: () => "connected",
      update: (value) => value,
    });
    useLanguageIntelligenceMock.mockReturnValue({
      filePath: "src/app.ts",
      extensions: [sessionExtension],
      sessionId: "session-1",
      capabilities: { definitionProvider: true },
    });
    rerender(<WorkspaceFileEditor ref={ref} {...props} />);

    await waitFor(() => {
      const editor = container.querySelector(".cm-editor");
      expect(editor).not.toBeNull();
      const view = EditorView.findFromDOM(editor as HTMLElement);
      expect(view?.state.field(sessionExtension)).toBe("connected");
      expect(container.querySelector(".cm-content")).toBe(content);
      expect(ref.current?.getSelectionRange()).toEqual(selection);
    });
  });
});
