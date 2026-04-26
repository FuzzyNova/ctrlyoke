import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { useUiStore } from "@store/uiStore";

vi.mock("@hooks/useMessageHandler", () => ({
  openFile: vi.fn(),
}));

vi.mock("@utils/hljsUtils", () => ({
  getLanguageFromPath: vi.fn(() => "typescript"),
}));

vi.mock("@components/output/DiffView", () => ({
  DiffView: vi.fn(
    ({
      actionSlot,
    }: {
      actionSlot?: ReactNode;
    }) => (
      <div>
        <div>mock diff</div>
        {actionSlot}
      </div>
    )
  ),
}));

import { FileEditOutput } from "@components/output/FileOperationOutput";
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
});
