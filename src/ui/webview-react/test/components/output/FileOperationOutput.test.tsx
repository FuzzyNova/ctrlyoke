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

    expect(getByRole("button", { name: "Undo" })).toBeTruthy();
  });

  it("renders a redo button when the diff is already undone", () => {
    const { getByRole } = render(
      <FileEditOutput
        path="src/example.ts"
        status={OPERATION_STATUS.COMPLETED}
        oldContent={"const a = 1;\n"}
        newContent={"const a = 2;\n"}
        onUndoFile={vi.fn()}
        fileUndoMode="redo"
      />
    );

    expect(getByRole("button", { name: "Redo" })).toBeTruthy();
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
