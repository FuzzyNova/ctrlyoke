import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  WorkspaceLanguageReferencesPanel,
  referencePreviewParts,
} from "@components/workspace-viewer/WorkspaceLanguageReferencesPanel";
import {
  useWorkspaceViewerStore,
  type LanguageReferenceResult,
} from "@store/workspaceViewerStore";
import { useEditorStore } from "@store/editorStore";
import { useIsMobile } from "@hooks/useMediaQuery";

vi.mock("@hooks/useMediaQuery", () => ({
  useIsMobile: vi.fn(() => false),
}));

const ORIGIN = { path: "src/hooks/useMediaQuery.ts", line: 2, character: 16 };

const RESULTS: LanguageReferenceResult[] = [
  {
    path: "src/App.tsx",
    line: 5,
    startCharacter: 13,
    endCharacter: 21,
    preview: "  isMobile = useIsMobile();",
  },
  {
    path: "src/App.tsx",
    line: 9,
    startCharacter: 4,
    endCharacter: 12,
    preview: "if (isMobile) {",
  },
  {
    path: "src/hooks/useMediaQuery.ts",
    line: 2,
    startCharacter: 16,
    endCharacter: 24,
    preview: "export function isMobile(): boolean {",
  },
];

function showResults(selected: { path: string; line: number } | null = null) {
  const store = useWorkspaceViewerStore.getState();
  store.showLanguageReferences(ORIGIN, selected);
  store.setLanguageReferenceResults(ORIGIN, RESULTS);
}

describe("workspace language references panel", () => {
  beforeEach(() => {
    useWorkspaceViewerStore.getState().reset();
    vi.mocked(useIsMobile).mockReturnValue(false);
  });

  it("groups references by file under a symbol heading", () => {
    showResults();
    render(<WorkspaceLanguageReferencesPanel />);

    expect(
      screen.getByRole("heading", { name: "References to isMobile" })
    ).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("3 results in 2 files");
    const appGroup = screen.getByRole("region", { name: "src/App.tsx" });
    expect(
      within(appGroup).getAllByRole("button", { name: /^src\/App\.tsx, line/ })
    ).toHaveLength(2);
    expect(
      within(appGroup).getByRole("button", { name: "src/App.tsx, line 9" })
        .textContent
    ).toBe("9if (isMobile) {");
  });

  it("stays open and marks the reference it navigated to", () => {
    showResults();
    render(<WorkspaceLanguageReferencesPanel />);

    fireEvent.click(
      screen.getByRole("button", { name: "src/App.tsx, line 9" })
    );

    const state = useWorkspaceViewerStore.getState();
    expect(state.pendingNavigation).toEqual({
      type: "file",
      filePath: "src/App.tsx",
      startLine: 9,
      endLine: 9,
    });
    expect(state.languageReferences?.selected).toEqual({
      path: "src/App.tsx",
      line: 9,
    });
    expect(
      screen
        .getByRole("button", { name: "src/App.tsx, line 9" })
        .getAttribute("aria-current")
    ).toBe("location");
  });

  it("hides on mobile once a reference is opened, until reopened", () => {
    vi.mocked(useIsMobile).mockReturnValue(true);
    showResults();
    const { container, rerender } = render(
      <WorkspaceLanguageReferencesPanel />
    );
    const panel = () =>
      container.querySelector<HTMLElement>('section[aria-label="References"]');

    fireEvent.click(
      screen.getByRole("button", { name: "src/App.tsx, line 5" })
    );
    rerender(<WorkspaceLanguageReferencesPanel />);
    // It slides out first, and only unmounts once that animation ends.
    expect(panel()?.className).toContain("animate-slide-out-right");
    expect(screen.queryByRole("region", { name: "References" })).toBeNull();
    // jsdom has no AnimationEvent, so React listens for the prefixed name.
    fireEvent(panel()!, new Event("webkitAnimationEnd", { bubbles: true }));
    expect(panel()).toBeNull();

    useWorkspaceViewerStore.getState().setLanguageReferencesPanelOpen(true);
    rerender(<WorkspaceLanguageReferencesPanel />);
    expect(screen.getByRole("region", { name: "References" })).toBeTruthy();
  });

  it("shows a selected reference's results closed on mobile", () => {
    vi.mocked(useIsMobile).mockReturnValue(true);
    showResults({ path: "src/App.tsx", line: 5 });
    render(<WorkspaceLanguageReferencesPanel />);
    expect(screen.queryByRole("region", { name: "References" })).toBeNull();
  });

  it("adds a reference row to the prompt editor as workflow context", () => {
    showResults();
    render(<WorkspaceLanguageReferencesPanel />);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Add src/App.tsx, line 9 to ctrlyoke",
      })
    );
    const inserts = useEditorStore.getState().pendingPromptEditorInserts;
    expect(inserts[inserts.length - 1]?.references).toEqual([
      "#selection:src/App.tsx:9-9",
    ]);
  });

  it("clears the references view", () => {
    showResults();
    render(<WorkspaceLanguageReferencesPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Close references" }));
    expect(useWorkspaceViewerStore.getState().languageReferences).toBeNull();
  });

  it("shows the query's error instead of results", () => {
    const store = useWorkspaceViewerStore.getState();
    store.showLanguageReferences(ORIGIN);
    store.setLanguageReferenceResults(ORIGIN, [], "Not available.");
    render(<WorkspaceLanguageReferencesPanel />);
    expect(screen.getByText("Not available.")).toBeTruthy();
  });
});

describe("referencePreviewParts", () => {
  it("drops indentation and splits around the symbol", () => {
    expect(referencePreviewParts("    foo(bar);", 8, 11)).toEqual({
      before: "foo(",
      match: "bar",
      after: ");",
    });
  });

  it("trims long leading context so the symbol stays visible", () => {
    const line = `${"x".repeat(60)}target()`;
    const parts = referencePreviewParts(line, 60, 66);
    expect(parts.before).toBe(`…${"x".repeat(24)}`);
    expect(parts.match).toBe("target");
  });
});
