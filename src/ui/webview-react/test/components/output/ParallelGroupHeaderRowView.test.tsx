import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { OutputRow } from "@components/output/OutputRow";
import type { ParallelGroupHeaderRow } from "@utils/outputRows";
import { FINAL_STEP_PHASES } from "@/types/messages";
import { OUTPUT_ROW_KINDS } from "@root/types/DashboardConstants";
import { useUiStore } from "@store/uiStore";

function buildHeaderRow(
  overrides: Partial<ParallelGroupHeaderRow> = {}
): ParallelGroupHeaderRow {
  return {
    key: "parallel-group:parallel-0-1",
    rowKind: OUTPUT_ROW_KINDS.PARALLEL_GROUP_HEADER,
    target: { kind: FINAL_STEP_PHASES.QUEUE, index: 0 },
    groupId: "parallel-0-1",
    startIndex: 0,
    endIndex: 1,
    members: [
      { stepIndex: 0, targetKey: "queue:0", label: "auth", isSoloed: false },
      {
        stepIndex: 1,
        targetKey: "queue:1",
        label: "database",
        isSoloed: false,
      },
    ],
    running: 1,
    complete: 1,
    failed: 0,
    isAllVisible: true,
    estimateSize: 60,
    ...overrides,
  };
}

describe("ParallelGroupHeaderRowView", () => {
  beforeEach(() => {
    useUiStore.getState().clearHiddenOutputTargets("_shell");
  });

  it("renders the group title, member counts, and one chip per member", () => {
    render(<OutputRow row={buildHeaderRow()} isExecutionActive={true} />);

    expect(screen.getByText("Parallel steps 1–2")).toBeInTheDocument();
    expect(
      screen.getByText("1 running · 1 complete · 0 failed")
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(screen.getByRole("button", { name: "1 auth" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "2 database" })
    ).toBeInTheDocument();
  });

  it("solos a member into the shared hidden-target filter, and clears it again", () => {
    render(<OutputRow row={buildHeaderRow()} isExecutionActive={true} />);

    fireEvent.click(screen.getByRole("button", { name: "2 database" }));
    expect(useUiStore.getState().hiddenOutputTargets._shell?.keys).toEqual([
      "queue:0",
    ]);

    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(useUiStore.getState().hiddenOutputTargets).toEqual({});
  });

  it("reflects the soloed member the row was built with", () => {
    render(
      <OutputRow
        row={buildHeaderRow({
          isAllVisible: false,
          members: [
            {
              stepIndex: 0,
              targetKey: "queue:0",
              label: "auth",
              isSoloed: false,
            },
            {
              stepIndex: 1,
              targetKey: "queue:1",
              label: "database",
              isSoloed: true,
            },
          ],
        })}
        isExecutionActive={true}
      />
    );

    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute(
      "aria-pressed",
      "false"
    );
    expect(screen.getByRole("button", { name: "2 database" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  });

  it("offers the group's undo only when the row carries an undo action", () => {
    const onPromptUndo = vi.fn();
    const { rerender } = render(
      <OutputRow
        row={buildHeaderRow()}
        isExecutionActive={false}
        onPromptUndo={onPromptUndo}
      />
    );

    expect(screen.queryByRole("button", { name: /Undo/ })).toBeNull();

    const row = buildHeaderRow({
      promptUndo: {
        workspacePath: "/repo",
        allStepOutputs: [],
        undo: { label: "Undo 3 changes", count: 3 },
        redo: null,
      },
    });
    rerender(
      <OutputRow
        row={row}
        isExecutionActive={false}
        onPromptUndo={onPromptUndo}
      />
    );

    const undoButton = screen.getByRole("button", { name: "Undo 3 changes" });
    // The label matches every other undo surface; only the tooltip says the
    // action covers the whole group.
    expect(undoButton).toHaveAttribute(
      "title",
      "Undo 3 changes across 2 parallel steps"
    );
    fireEvent.click(undoButton);
    expect(onPromptUndo).toHaveBeenCalledWith(row);
  });

  it("offers the group's redo on the header once the undo has been applied", () => {
    const onPromptRedo = vi.fn();
    const row = buildHeaderRow({
      promptUndo: {
        workspacePath: "/repo",
        allStepOutputs: [],
        undo: null,
        redo: { label: "Redo 3 changes", count: 3 },
      },
    });
    render(
      <OutputRow
        row={row}
        isExecutionActive={false}
        onPromptRedo={onPromptRedo}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Redo 3 changes" }));
    expect(onPromptRedo).toHaveBeenCalledWith(row);
  });
});
