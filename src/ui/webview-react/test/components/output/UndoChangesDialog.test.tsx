import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { UndoChangesDialog } from "@components/output/UndoChangesDialog";
import { useWorkflowStore } from "@store/workflowStore";
import { FINAL_STEP_PHASES } from "@root/types/DashboardConstants";
import type { OutputExecutionTarget } from "@root/types/OutputHistoryTypes";
import type { UndoFileCandidate } from "@/types/messages";

vi.mock("@utils/syntaxHighlighting", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@utils/syntaxHighlighting")>();
  return {
    ...original,
    getLanguageFromPath: vi.fn(() => "typescript"),
  };
});

describe("UndoChangesDialog", () => {
  const queueTarget: OutputExecutionTarget = {
    kind: FINAL_STEP_PHASES.QUEUE,
    stepIndex: 0,
  };

  beforeEach(() => {
    useWorkflowStore.getState().resetWorkflow();
  });

  it("does not render the prompt-level empty state in workflow undo mode", () => {
    const undoCandidate: UndoFileCandidate = {
      path: "src/example.ts",
      changeType: "modified",
      tier: "tier1",
      instruction: {
        path: "src/example.ts",
        action: "reverse-patch",
        structuredPatch: [
          {
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            lines: ["-before", "+after"],
          },
        ],
      },
    };

    render(
      <UndoChangesDialog
        mode="undo"
        target={queueTarget}
        workspacePath="C:/dev/FlightPath"
        requestId="workflow-undo-test"
        onClose={vi.fn()}
        workflowEntries={[
          {
            target: queueTarget,
            label: "Step 1",
            undoCandidates: [undoCandidate],
          },
        ]}
      />
    );

    expect(screen.getByText("Step 1")).toBeInTheDocument();
    expect(screen.getByText("src/example.ts")).toBeInTheDocument();
    expect(
      screen.queryByText("No file changes found for this prompt.")
    ).not.toBeInTheDocument();
  });
});
