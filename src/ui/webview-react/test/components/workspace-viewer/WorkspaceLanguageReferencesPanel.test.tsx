import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  WorkspaceLanguageReferencesPanel,
  formatLanguageReference,
} from "@components/workspace-viewer/WorkspaceLanguageReferencesPanel";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";
import { useEditorStore } from "@store/editorStore";

describe("workspace language references", () => {
  beforeEach(() => useWorkspaceViewerStore.getState().reset());

  it("formats references as path#L10-L12 and navigates to the result", () => {
    expect(formatLanguageReference("src/app.ts", 10, 12)).toBe(
      "src/app.ts#L10-L12"
    );
    useWorkspaceViewerStore
      .getState()
      .setLanguageReferences([
        { path: "src/app.ts", startLine: 10, endLine: 12 },
      ]);
    render(<WorkspaceLanguageReferencesPanel />);
    fireEvent.click(screen.getByRole("button", { name: "src/app.ts#L10-L12" }));
    expect(useWorkspaceViewerStore.getState().pendingNavigation).toEqual({
      type: "file",
      filePath: "src/app.ts",
      startLine: 10,
      endLine: 12,
    });
  });

  it("adds a reference row to the prompt editor as workflow context", () => {
    useWorkspaceViewerStore
      .getState()
      .setLanguageReferences([
        { path: "src/app.ts", startLine: 10, endLine: 12 },
      ]);
    render(<WorkspaceLanguageReferencesPanel />);
    fireEvent.click(
      screen.getByRole("button", { name: "Add src/app.ts#L10-L12 to ctrlyoke" })
    );
    const inserts = useEditorStore.getState().pendingPromptEditorInserts;
    expect(inserts[inserts.length - 1]?.references).toEqual([
      "#selection:src/app.ts:10-12",
    ]);
  });
});
