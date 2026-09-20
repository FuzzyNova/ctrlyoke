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

  it("offers the group's changes when the row carries a change summary", () => {
    const onPromptView = vi.fn();
    const { rerender } = render(
      <OutputRow
        row={buildHeaderRow()}
        isExecutionActive={false}
        onPromptView={onPromptView}
      />
    );

    expect(screen.queryByRole("button", { name: /View/ })).toBeNull();

    const row = buildHeaderRow({
      promptUndo: {
        workspacePath: "/repo",
        allStepOutputs: [],
        summary: {
          total: 3,
          undoable: 3,
          undone: 0,
          blocked: 0,
          label: "View 3 changes",
          compactLabel: "View 3",
          title: "3 files changed",
        },
      },
    });
    rerender(
      <OutputRow
        row={row}
        isExecutionActive={false}
        onPromptView={onPromptView}
      />
    );

    const undoButton = screen.getByRole("button", {
      name: "View 3 changes",
    });
    expect(undoButton).toHaveAttribute(
      "title",
      "3 files changed across 2 parallel steps"
    );
    fireEvent.click(undoButton);
    expect(onPromptView).toHaveBeenCalledWith(row);
  });

  it("keeps the undone state in the group's neutral viewer", () => {
    const onPromptView = vi.fn();
    const row = buildHeaderRow({
      promptUndo: {
        workspacePath: "/repo",
        allStepOutputs: [],
        summary: {
          total: 3,
          undoable: 0,
          undone: 3,
          blocked: 0,
          label: "View 3 changes (all undone)",
          compactLabel: "View 3",
          title: "3 files changed · 3 undone, can be redone",
        },
      },
    });
    render(
      <OutputRow
        row={row}
        isExecutionActive={false}
        onPromptView={onPromptView}
      />
    );

    fireEvent.click(
      screen.getByRole("button", { name: "View 3 changes (all undone)" })
    );
    expect(onPromptView).toHaveBeenCalledWith(row);
  });
});
