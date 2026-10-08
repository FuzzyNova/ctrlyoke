import { describe, expect, it, vi } from "vitest";
import { buildLanguageIntelligenceMenuItems } from "@hooks/useWorkspaceEditorContextMenu";
import { render, fireEvent } from "@testing-library/react";
import { WorkspaceFileEditor } from "@components/workspace-viewer/WorkspaceFileEditor";

const { requestLanguageIntelligence } = vi.hoisted(() => ({
  requestLanguageIntelligence: vi.fn(),
}));
vi.mock("@hooks/useLanguageIntelligence", () => ({
  useLanguageIntelligence: () => ({
    filePath: "src/app.ts",
    extensions: [],
    sessionId: "session-1",
    capabilities: { definitionProvider: true },
  }),
}));
vi.mock("@utils/languageIntelligenceClient", async () => {
  const actual = await vi.importActual<
    typeof import("@utils/languageIntelligenceClient")
  >("@utils/languageIntelligenceClient");
  return { ...actual, requestLanguageIntelligence };
});

describe("workspace editor language actions", () => {
  it.each([
    ["definitionProvider", "Go to Definition"],
    ["referencesProvider", "Find All References"],
    ["renameProvider", "Rename Symbol"],
    ["documentFormattingProvider", "Format Document"],
  ])(
    "hides %s menu action when the capability is absent",
    (capability, label) => {
      const ref = { current: null };
      const labels = (
        items: ReturnType<typeof buildLanguageIntelligenceMenuItems>
      ) => items.flatMap((item) => ("label" in item ? [item.label] : []));
      expect(labels(buildLanguageIntelligenceMenuItems(ref, {}))).not.toContain(
        label
      );
      expect(
        labels(buildLanguageIntelligenceMenuItems(ref, { [capability]: true }))
      ).toContain(label);
    }
  );

  it("dispatches a definition request from F12", async () => {
    requestLanguageIntelligence.mockResolvedValue(null);
    const { container } = render(
      <WorkspaceFileEditor
        filePath="src/app.ts"
        content="const value = 1"
        onChange={vi.fn()}
        onSave={vi.fn()}
      />
    );
    const editor = container.querySelector(".cm-content");
    expect(editor).not.toBeNull();
    fireEvent.keyDown(editor!, { key: "F12", keyCode: 123 });
    await vi.waitFor(() =>
      expect(requestLanguageIntelligence).toHaveBeenCalledWith(
        "session-1",
        "textDocument/definition",
        expect.objectContaining({
          textDocument: { uri: "file:///__ctrlyoke_workspace__/src/app.ts" },
        })
      )
    );
  });
});
