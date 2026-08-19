import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { UndoChangesDialog } from "@components/output/UndoChangesDialog";
import { useWorkflowStore } from "@store/workflowStore";
import { useUiStore } from "@store/uiStore";
import {
  FINAL_STEP_PHASES,
  MESSAGE_TYPES,
} from "@root/types/DashboardConstants";
import type { OutputExecutionTarget } from "@root/types/OutputHistoryTypes";
import type { RunRef, WorkflowKey } from "@root/types/CtrlYokeTypes";
import type { UndoFileCandidate, UndoFileInstruction } from "@/types/messages";

const { sendMessageMock } = vi.hoisted(() => ({
  sendMessageMock: vi.fn(),
}));

vi.mock("@hooks/useMessageHandler", () => ({
  sendMessage: sendMessageMock,
}));

vi.mock("@utils/syntaxHighlighting", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@utils/syntaxHighlighting")>();
  return {
    ...original,
    getLanguageFromPath: vi.fn(() => "typescript"),
  };
});

vi.mock("@components/output/DiffView", () => ({
  DiffView: ({ collapsed }: { collapsed?: boolean }) => (
    <div data-testid="dialog-diff-view" data-collapsed={String(collapsed)} />
  ),
}));

describe("UndoChangesDialog", () => {
  const workflowKey = "workflow-test" as WorkflowKey;
  const runRef = "run-2026-08-11T00-00-00-000Z" as RunRef;
  const queueTarget: OutputExecutionTarget = {
    kind: FINAL_STEP_PHASES.QUEUE,
    stepIndex: 0,
  };

  beforeEach(() => {
    useWorkflowStore.getState().resetWorkflow();
    sendMessageMock.mockReset();
  });

  it("renders workflow undo rows without the prompt-level empty state", () => {
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
        workflowKey={workflowKey}
        runRef={runRef}
        workspacePath="C:/dev/ctrlyoke"
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
    expect(screen.getByLabelText("src/example.ts")).toBeInTheDocument();
    expect(
      screen.queryByText("No file changes found for this prompt.")
    ).not.toBeInTheDocument();
  });

  it("applies versioned Expand all and Collapse all commands to dialog diffs", () => {
    useUiStore.getState().setUndoDialogDiffsCollapsed(true);
    const instruction: UndoFileInstruction = {
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
    };

    render(
      <UndoChangesDialog
        mode="undo"
        target={queueTarget}
        workflowKey={workflowKey}
        runRef={runRef}
        workspacePath="C:/dev/ctrlyoke"
        requestId="dialog-collapse-command"
        onClose={vi.fn()}
        input={{
          scope: { mode: "prompt" as const, target: queueTarget },
          eventAttributedFiles: [
            {
              path: instruction.path,
              changeType: "modified",
              tier: "tier1",
              instruction,
              structuredPatch: instruction.structuredPatch,
            },
          ],
          snapshotOnlyFiles: [],
          workspacePath: "C:/dev/ctrlyoke",
        }}
      />
    );

    expect(screen.getByTestId("dialog-diff-view")).toHaveAttribute(
      "data-collapsed",
      "true"
    );
    fireEvent.click(screen.getByRole("button", { name: "Expand all diffs" }));
    expect(screen.getByTestId("dialog-diff-view")).toHaveAttribute(
      "data-collapsed",
      "false"
    );
    fireEvent.click(screen.getByRole("button", { name: "Collapse all diffs" }));
    expect(screen.getByTestId("dialog-diff-view")).toHaveAttribute(
      "data-collapsed",
      "true"
    );
  });

  it("renders the four undo and redo row shapes through the shared card", () => {
    const undoInstruction: UndoFileInstruction = {
      path: "src/undo.ts",
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
    };
    const redoInstruction: UndoFileInstruction = {
      path: "src/redo.ts",
      action: "restore-content",
      structuredPatch: undoInstruction.structuredPatch,
    };
    const candidate: UndoFileCandidate = {
      path: undoInstruction.path,
      changeType: "modified",
      tier: "tier1",
      instruction: undoInstruction,
      structuredPatch: undoInstruction.structuredPatch,
    };

    const cases = [
      {
        mode: "undo" as const,
        input: {
          scope: { mode: "prompt" as const, target: queueTarget },
          eventAttributedFiles: [candidate],
          snapshotOnlyFiles: [],
          workspacePath: "C:/dev/ctrlyoke",
        },
        expectedPath: "src/undo.ts",
      },
      {
        mode: "redo" as const,
        redoInstructions: [redoInstruction],
        expectedPath: "src/redo.ts",
      },
      {
        mode: "undo" as const,
        workflowEntries: [
          { target: queueTarget, label: "Step 1", undoCandidates: [candidate] },
        ],
        expectedPath: "src/undo.ts",
      },
      {
        mode: "redo" as const,
        workflowEntries: [
          {
            target: queueTarget,
            label: "Step 1",
            redoInstructions: [redoInstruction],
          },
        ],
        expectedPath: "src/redo.ts",
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      const view = render(
        <UndoChangesDialog
          mode={testCase.mode}
          target={queueTarget}
          workflowKey={workflowKey}
          runRef={runRef}
          workspacePath="C:/dev/ctrlyoke"
          requestId={`row-shape-${index}`}
          onClose={vi.fn()}
          input={testCase.input}
          redoInstructions={testCase.redoInstructions}
          workflowEntries={testCase.workflowEntries}
        />
      );

      expect(screen.getByLabelText(testCase.expectedPath)).toBeInTheDocument();
      view.unmount();
    }
  });

  it("keeps the single-step undo payload unchanged", () => {
    const instruction: UndoFileInstruction = {
      path: "src/example.ts",
      action: "reverse-patch",
      structuredPatch: [],
    };
    const input = {
      scope: { mode: "prompt" as const, target: queueTarget },
      eventAttributedFiles: [
        {
          path: instruction.path,
          changeType: "modified" as const,
          tier: "tier1" as const,
          instruction,
        },
      ],
      snapshotOnlyFiles: [],
      workspacePath: "C:/dev/ctrlyoke",
    };

    render(
      <UndoChangesDialog
        mode="undo"
        target={queueTarget}
        workflowKey={workflowKey}
        runRef={runRef}
        workspacePath={input.workspacePath}
        input={input}
        requestId="single-undo-payload"
        onClose={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Undo Selected (1)" }));
    expect(sendMessageMock).toHaveBeenCalledWith(
      MESSAGE_TYPES.UNDO_PROMPT_CHANGES,
      {
        data: {
          requestId: "single-undo-payload",
          target: queueTarget,
          workflowKey,
          runRef,
          files: [instruction],
        },
      }
    );
  });

  it("opens the file when the header's open-file button is clicked", () => {
    const instruction: UndoFileInstruction = {
      path: "src/example.ts",
      action: "reverse-patch",
      structuredPatch: [],
    };
    const input = {
      scope: { mode: "prompt" as const, target: queueTarget },
      eventAttributedFiles: [
        {
          path: instruction.path,
          changeType: "modified" as const,
          tier: "tier1" as const,
          instruction,
        },
      ],
      snapshotOnlyFiles: [],
      workspacePath: "C:/dev/ctrlyoke",
    };
    const postMessage = vi.mocked(window.vscodeApi!.postMessage);
    postMessage.mockClear();

    render(
      <UndoChangesDialog
        mode="undo"
        target={queueTarget}
        workflowKey={workflowKey}
        runRef={runRef}
        workspacePath={input.workspacePath}
        input={input}
        requestId="open-file-test"
        onClose={vi.fn()}
      />
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Open src/example.ts" })
    );

    expect(postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.OPEN_FILE,
      path: "src/example.ts",
    });
  });

  it("keeps the single-step redo payload unchanged", () => {
    const instruction: UndoFileInstruction = {
      path: "src/example.ts",
      action: "restore-content",
      contentToRestore: "after",
    };

    render(
      <UndoChangesDialog
        mode="redo"
        target={queueTarget}
        workflowKey={workflowKey}
        runRef={runRef}
        workspacePath="C:/dev/ctrlyoke"
        redoInstructions={[instruction]}
        requestId="single-redo-payload"
        onClose={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Redo Selected (1)" }));
    expect(sendMessageMock).toHaveBeenCalledWith(
      MESSAGE_TYPES.REDO_PROMPT_CHANGES,
      {
        data: {
          requestId: "single-redo-payload",
          target: queueTarget,
          workflowKey,
          runRef,
          files: [instruction],
        },
      }
    );
  });

  it("keeps workflow undo and redo payloads unchanged", () => {
    const undoInstruction: UndoFileInstruction = {
      path: "src/undo.ts",
      action: "delete",
    };
    const redoInstruction: UndoFileInstruction = {
      path: "src/redo.ts",
      action: "restore-content",
      contentToRestore: "after",
    };
    const entries = [
      {
        target: queueTarget,
        label: "Step 1",
        undoCandidates: [
          {
            path: undoInstruction.path,
            changeType: "created" as const,
            tier: "tier1" as const,
            instruction: undoInstruction,
          },
        ],
        redoInstructions: [redoInstruction],
      },
    ];

    const undoView = render(
      <UndoChangesDialog
        mode="undo"
        target={queueTarget}
        workflowKey={workflowKey}
        runRef={runRef}
        workspacePath="C:/dev/ctrlyoke"
        workflowEntries={entries}
        requestId="workflow-undo-payload"
        onClose={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Undo Selected (1)" }));
    expect(sendMessageMock).toHaveBeenCalledWith(
      MESSAGE_TYPES.UNDO_WORKFLOW_CHANGES,
      {
        data: {
          requestId: "workflow-undo-payload",
          workflowKey,
          runRef,
          entries: [{ target: queueTarget, files: [undoInstruction] }],
        },
      }
    );

    undoView.unmount();
    sendMessageMock.mockReset();
    render(
      <UndoChangesDialog
        mode="redo"
        target={queueTarget}
        workflowKey={workflowKey}
        runRef={runRef}
        workspacePath="C:/dev/ctrlyoke"
        workflowEntries={entries}
        requestId="workflow-redo-payload"
        onClose={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Redo Selected (1)" }));
    expect(sendMessageMock).toHaveBeenCalledWith(
      MESSAGE_TYPES.REDO_WORKFLOW_CHANGES,
      {
        data: {
          requestId: "workflow-redo-payload",
          workflowKey,
          runRef,
          entries: [{ target: queueTarget, files: [redoInstruction] }],
        },
      }
    );
  });

  it("renders one aggregated workflow row and sends undo steps newest first", () => {
    const base = "base\n";
    const stepOne = "step one\n";
    const entries = [
      {
        target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
        label: "Prompt 1",
        undoCandidates: [
          {
            path: "src/shared.ts",
            changeType: "modified" as const,
            tier: "tier1" as const,
            oldContent: base,
            structuredPatch: [
              {
                oldStart: 1,
                oldLines: 1,
                newStart: 1,
                newLines: 1,
                lines: ["-base", "+step one"],
              },
            ],
            instruction: {
              path: "src/shared.ts",
              action: "reverse-patch" as const,
              structuredPatch: [
                {
                  oldStart: 1,
                  oldLines: 1,
                  newStart: 1,
                  newLines: 1,
                  lines: ["-base", "+step one"],
                },
              ],
            },
          },
        ],
      },
      {
        target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 2 },
        label: "Prompt 3",
        undoCandidates: [
          {
            path: "C:\\repo\\src\\shared.ts",
            changeType: "modified" as const,
            tier: "tier1" as const,
            oldContent: stepOne,
            structuredPatch: [
              {
                oldStart: 1,
                oldLines: 1,
                newStart: 1,
                newLines: 1,
                lines: ["-step one", "+step three"],
              },
            ],
            instruction: {
              path: "src/shared.ts",
              action: "reverse-patch" as const,
              structuredPatch: [
                {
                  oldStart: 1,
                  oldLines: 1,
                  newStart: 1,
                  newLines: 1,
                  lines: ["-step one", "+step three"],
                },
              ],
            },
          },
        ],
      },
    ];

    render(
      <UndoChangesDialog
        mode="undo"
        target={queueTarget}
        workflowKey={workflowKey}
        runRef={runRef}
        workspacePath="C:/dev/ctrlyoke"
        workflowEntries={entries}
        requestId="workflow-aggregate-undo"
        onClose={vi.fn()}
      />
    );

    expect(screen.getAllByLabelText("src/shared.ts")).toHaveLength(1);
    expect(screen.getByText("Prompt 1, Prompt 3")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Undo Selected (1)" }));
    expect(sendMessageMock).toHaveBeenCalledWith(
      MESSAGE_TYPES.UNDO_WORKFLOW_CHANGES,
      {
        data: {
          requestId: "workflow-aggregate-undo",
          workflowKey,
          runRef,
          entries: [
            {
              target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 2 },
              files: [entries[1].undoCandidates[0].instruction],
            },
            {
              target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
              files: [entries[0].undoCandidates[0].instruction],
            },
          ],
        },
      }
    );
  });
});
