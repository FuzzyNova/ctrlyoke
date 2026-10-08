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
import * as languageClient from "@utils/languageIntelligenceClient";

const { useLanguageIntelligenceMock } = vi.hoisted(() => ({
  useLanguageIntelligenceMock: vi.fn(() => ({
    filePath: "src/app.ts",
    extensions: [] as Extension[],
    sessionId: null as string | null,
    capabilities: {},
    statusHint: null as string | null,
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
      statusHint: null,
    });
  });

  it("shows lookup reasons in a small editor status hint", () => {
    useLanguageIntelligenceMock.mockReturnValue({
      filePath: "src/app.ts",
      extensions: [],
      sessionId: null,
      capabilities: {},
      statusHint: "Language server is stopped.",
    });
    const { getByRole } = render(
      <WorkspaceFileEditor
        filePath="src/app.ts"
        content="const value = 1"
        onChange={vi.fn()}
        onSave={vi.fn()}
      />
    );
    expect(getByRole("status").textContent).toContain(
      "Language server is stopped."
    );
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
      statusHint: null,
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

  it("seeds a recreated read-only view with the current language extension", async () => {
    const sessionExtension = StateField.define({
      create: () => "connected",
      update: (value) => value,
    });
    useLanguageIntelligenceMock.mockReturnValue({
      filePath: "src/app.ts",
      extensions: [sessionExtension],
      sessionId: "session-1",
      capabilities: { documentFormattingProvider: true },
      statusHint: null,
    });
    const props = {
      filePath: "src/app.ts",
      content: "const value = 1",
      onChange: vi.fn(),
      onSave: vi.fn(),
    };
    const { container, rerender } = render(<WorkspaceFileEditor {...props} />);
    rerender(<WorkspaceFileEditor {...props} readOnly />);
    await waitFor(() => {
      const editor = container.querySelector(".cm-editor") as HTMLElement;
      expect(
        EditorView.findFromDOM(editor)?.state.field(sessionExtension)
      ).toBe("connected");
    });
  });

  it("formats a document without a trailing newline without duplicating its last line", async () => {
    vi.spyOn(languageClient, "requestLanguageIntelligence").mockResolvedValue([
      {
        range: {
          start: { line: 0, character: 0 },
          end: { line: 2, character: 0 },
        },
        newText: "formatted",
      },
    ]);
    useLanguageIntelligenceMock.mockReturnValue({
      filePath: "src/app.ts",
      extensions: [],
      sessionId: "session-1",
      capabilities: {},
      statusHint: null,
    });
    const ref = createRef<WorkspaceFileEditorHandle>();
    const { container } = render(
      <WorkspaceFileEditor
        ref={ref}
        filePath="src/app.ts"
        content="one\ntwo"
        onChange={vi.fn()}
        onSave={vi.fn()}
      />
    );
    await ref.current?.formatDocument();
    await waitFor(() =>
      expect(container.querySelector(".cm-content")?.textContent).toBe(
        "formatted"
      )
    );
  });
});
