import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { useUiStore } from "@store/uiStore";

vi.mock("@hooks/useMessageHandler", () => ({
  openFile: vi.fn(),
}));

vi.mock("@utils/syntaxHighlighting", () => ({
  getLanguageFromPath: vi.fn(() => "typescript"),
}));

vi.mock("@components/output/DiffView", () => ({
  DiffView: vi.fn(({ actionSlot }: { actionSlot?: ReactNode }) => (
    <div>
      <div>mock diff</div>
      {actionSlot}
    </div>
  )),
}));

import {
  FileDeleteOutput,
  FileEditOutput,
  FileReadOutput,
  FileWriteOutput,
} from "@components/output/FileOperationOutput";
import { GenericToolCallOutput } from "@components/output/ToolCallOutput";
import { OPERATION_STATUS } from "@/types/cliEvents";
import { UNDO_REDO_DIRECTIONS } from "@root/types/DashboardConstants";

describe("FileEditOutput", () => {
  beforeEach(() => {
    useUiStore.setState({ diffsCollapsed: false, diffResetVersion: 0 });
  });

  it("renders an undo button above completed diffs", () => {
    const onUndoFile = vi.fn();
    const { getByRole } = render(
      <FileEditOutput
        path="src/example.ts"
        status={OPERATION_STATUS.COMPLETED}
        oldContent={"const a = 1;\n"}
        newContent={"const a = 2;\n"}
        onUndoFile={onUndoFile}
      />
    );

    expect(getByRole("button", { name: "Undo file operation" })).toBeTruthy();
  });

  it("renders a redo button when the diff is already undone", () => {
    const { getByRole } = render(
      <FileEditOutput
        path="src/example.ts"
        status={OPERATION_STATUS.COMPLETED}
        oldContent={"const a = 1;\n"}
        newContent={"const a = 2;\n"}
        onUndoFile={vi.fn()}
        fileUndoMode={UNDO_REDO_DIRECTIONS.REDO}
      />
    );

    expect(getByRole("button", { name: "Redo file operation" })).toBeTruthy();
  });

  it("uses file chips for every structured operation when enabled", () => {
    const props = { path: "src/example.ts", atomicContextReferences: true };
    render(
      <>
        <FileEditOutput {...props} />
        <FileWriteOutput {...props} />
        <FileReadOutput {...props} />
        <FileDeleteOutput {...props} />
      </>
    );

    expect(
      screen.getAllByRole("button", { name: "Open src/example.ts" })
    ).toHaveLength(4);
    expect(
      screen
        .getAllByRole("button")
        .every((button) => button.classList.contains("atomic-reference-chip"))
    ).toBe(true);
  });

  it("keeps the complete path visible for a hidden filePath find match", () => {
    render(
      <FileReadOutput
        path="src/ui/webview-react/File.tsx"
        atomicContextReferences
        filePathFindMatches={[{ start: 4, end: 6, active: true }]}
      />
    );

    const chip = screen.getByRole("button", {
      name: "Open src/ui/webview-react/File.tsx",
    });

    expect(chip).toHaveTextContent("src/ui/webview-react/File.tsx");
    expect(chip.querySelector("mark")).toHaveTextContent("ui");
    expect(chip.querySelector("mark")).toHaveAttribute(
      "data-find-active",
      "true"
    );
  });

  it("opens a line-range read scrolled to that range instead of the whole file", () => {
    render(
      <FileReadOutput path="src/example.ts" lineStart={12} lineEnd={24} />
    );

    expect(screen.getByTitle("Open src/example.ts:12-24")).toBeTruthy();
  });

  it("renders a line-range read as a selection reference chip when enabled", () => {
    render(
      <FileReadOutput
        path="src/example.ts"
        lineStart={12}
        lineEnd={24}
        atomicContextReferences
      />
    );

    const chip = screen.getByRole("button", {
      name: "Open src/example.ts:12-24",
    });
    expect(chip.classList.contains("atomic-reference-chip")).toBe(true);
    expect(chip).toHaveTextContent("example.ts:12-24");
    expect(chip).toHaveAttribute("data-type", "lineRange");
    expect(chip).toHaveAttribute("data-line-start", "12");
    expect(chip).toHaveAttribute("data-line-end", "24");
  });

  // Multi-root workspaces hand the harness absolute paths, so file events come
  // back with OS-native separators — the chip must still compact those.
  it("compacts a Windows absolute path from a multi-root workspace", () => {
    const path = "c:\\dev\\ctrlyoke\\src\\utils\\ContextExpander.ts";
    render(<FileReadOutput path={path} atomicContextReferences />);

    const chip = screen.getByRole("button", { name: `Open ${path}` });
    expect(chip).toHaveTextContent("ContextExpander.ts");
    expect(chip).not.toHaveTextContent("dev");
  });

  it("expands a Windows absolute path when a find match hits its hidden portion", () => {
    const path = "c:\\dev\\ctrlyoke\\src\\utils\\ContextExpander.ts";
    const hiddenFrom = path.indexOf("ctrlyoke");
    render(
      <FileReadOutput
        path={path}
        atomicContextReferences
        filePathFindMatches={[
          {
            start: hiddenFrom,
            end: hiddenFrom + "ctrlyoke".length,
            active: true,
          },
        ]}
      />
    );

    const chip = screen.getByRole("button", { name: `Open ${path}` });
    expect(chip).toHaveTextContent(path);
    expect(chip.querySelector("mark")).toHaveTextContent("ctrlyoke");
  });

  it("does not rewrite arbitrary generic tool body text", () => {
    const { container } = render(
      <GenericToolCallOutput
        name="search"
        parameters={{}}
        result={{
          success: true,
          output: "path-like src/ui/webview-react/File.tsx text",
        }}
      />
    );

    expect(container.querySelector(".atomic-reference-chip")).toBeNull();
    expect(container).toHaveTextContent("src/ui/webview-react/File.tsx");
  });
});
