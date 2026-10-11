import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  it,
  expect,
  vi,
} from "vitest";
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { UndoChangesDialog } from "@components/output/UndoChangesDialog";
import { OutputSectionHeader } from "@components/layout/output-section/OutputSectionHeader";
import { useOutputUndoActions } from "@hooks/useOutputUndoActions";
import { useWorkflowStore } from "@store/workflowStore";
import { useUiStore } from "@store/uiStore";
import {
  FINAL_STEP_PHASES,
  FILE_OPERATION_KINDS,
  MESSAGE_TYPES,
  UNDO_DIALOG_INTENTS,
  UNDO_DIALOG_SCOPE_MODES,
  UNDO_REDO_DIRECTIONS,
  OUTPUT_TABS,
  WORKFLOW_VIEW_ADDRESS_KIND,
} from "@root/types/DashboardConstants";
import type { OutputExecutionTarget } from "@root/types/OutputHistoryTypes";
import type { RunRef, WorkflowKey } from "@root/types/CtrlYokeTypes";
import type { UndoFileCandidate, UndoFileInstruction } from "@/types/messages";
import { useWorkflowDisplayName } from "@hooks/useWorkflowDisplayName";

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

const originalOffsetHeight = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "offsetHeight"
);

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("flex-1") ? 600 : 40;
    },
  });
});

afterAll(() => {
  if (originalOffsetHeight) {
    Object.defineProperty(
      HTMLElement.prototype,
      "offsetHeight",
      originalOffsetHeight
    );
  }
});

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

  it("uses intent to control initial selection and the close action", () => {
    const instruction: UndoFileInstruction = {
      path: "src/intent.ts",
      action: "delete",
    };
    const input = {
      scope: { mode: UNDO_DIALOG_SCOPE_MODES.PROMPT, target: queueTarget },
      eventAttributedFiles: [
        {
          path: instruction.path,
          changeType: "created" as const,
          tier: "tier1" as const,
          instruction,
        },
      ],
      snapshotOnlyFiles: [],
      workspacePath: "C:/dev/ctrlyoke",
    };

    const view = render(
      <UndoChangesDialog
        mode={UNDO_REDO_DIRECTIONS.UNDO}
        intent={UNDO_DIALOG_INTENTS.VIEW}
        target={queueTarget}
        workflowKey={workflowKey}
        runRef={runRef}
        input={input}
        requestId="view-intent"
        onClose={vi.fn()}
        stepLabel="Step 1"
        stepName="Review changes"
      />
    );

    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Undo 0 files" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
    view.unmount();

    render(
      <UndoChangesDialog
        mode={UNDO_REDO_DIRECTIONS.UNDO}
        intent={UNDO_DIALOG_INTENTS.ACT}
        target={queueTarget}
        workflowKey={workflowKey}
        runRef={runRef}
        input={input}
        requestId="act-intent"
        onClose={vi.fn()}
      />
    );

    expect(screen.getByRole("checkbox")).toBeChecked();
    expect(screen.getByRole("button", { name: "Undo 1 file" })).toBeEnabled();
  });

  it("keeps undo and redo selection exclusive and follows the active direction", () => {
    const undoInstruction: UndoFileInstruction = {
      path: "src/applied.ts",
      action: "delete",
    };
    const redoInstruction: UndoFileInstruction = {
      path: "src/undone.ts",
      action: "restore-content",
      contentToRestore: "after",
    };

    render(
      <UndoChangesDialog
        mode={UNDO_REDO_DIRECTIONS.UNDO}
        intent={UNDO_DIALOG_INTENTS.VIEW}
        target={queueTarget}
        workflowKey={workflowKey}
        runRef={runRef}
        requestId="direction-exclusive"
        onClose={vi.fn()}
        workflowName="Workflow"
        workflowEntries={[
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
        ]}
      />
    );

    const undoCheckbox = screen.getByRole("checkbox", {
      name: "Select src/applied.ts",
    });
    const redoCheckbox = screen.getByRole("checkbox", {
      name: "Select src/undone.ts",
    });
    expect(screen.getByText("Undone")).toBeInTheDocument();

    fireEvent.click(undoCheckbox);
    expect(undoCheckbox).toBeChecked();
    expect(screen.getByRole("button", { name: "Undo 1 file" })).toBeEnabled();

    fireEvent.click(redoCheckbox);
    expect(undoCheckbox).not.toBeChecked();
    expect(redoCheckbox).toBeChecked();
    expect(screen.getByRole("button", { name: "Redo 1 file" })).toBeEnabled();
    expect(
      screen.getByText("Undo and redo are applied separately.")
    ).toBeInTheDocument();
  });

  it("uses scope titles and the supplied labels", () => {
    const instruction: UndoFileInstruction = {
      path: "src/title.ts",
      action: "delete",
    };
    const candidate: UndoFileCandidate = {
      path: instruction.path,
      changeType: "created",
      tier: "tier1",
      instruction,
    };
    const input = {
      scope: { mode: UNDO_DIALOG_SCOPE_MODES.PROMPT, target: queueTarget },
      eventAttributedFiles: [candidate],
      snapshotOnlyFiles: [],
      workspacePath: "C:/dev/ctrlyoke",
    };

    const cases = [
      {
        expectedTitle: "Workflow changes",
        expectedSubtitle: "Workflow title · 1 file",
        props: {
          workflowName: "Workflow title",
          workflowEntries: [
            {
              target: queueTarget,
              label: "Step 1",
              undoCandidates: [candidate],
            },
          ],
        },
      },
      {
        expectedTitle: "Step changes",
        expectedSubtitle: "Step 1 — Review changes · 1 file",
        props: { input, stepLabel: "Step 1", stepName: "Review changes" },
      },
      {
        expectedTitle: "File changes",
        expectedSubtitle: "src/title.ts",
        props: {
          input: {
            ...input,
            scope: {
              mode: UNDO_DIALOG_SCOPE_MODES.SINGLE_FILE,
              target: queueTarget,
              attemptIndex: 0,
              path: "src/title.ts",
            },
          },
        },
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      const view = render(
        <UndoChangesDialog
          mode={UNDO_REDO_DIRECTIONS.UNDO}
          target={queueTarget}
          workflowKey={workflowKey}
          runRef={runRef}
          requestId={`scope-title-${index}`}
          onClose={vi.fn()}
          {...testCase.props}
        />
      );
      expect(
        screen.getByRole("heading", { name: testCase.expectedTitle })
      ).toBeInTheDocument();
      expect(screen.getByText(testCase.expectedSubtitle)).toBeInTheDocument();
      view.unmount();
    }
  });

  it("uses the workflow header display name while a lineage switch is pending", () => {
    useWorkflowStore.setState({
      fileName: "/workspace/previous-workflow.yaml",
      workflowName: "Previous workflow",
    });
    useUiStore.setState({
      pendingRunViewSwitch: {
        requestId: "switch-request",
        workflowName: "Target workflow",
        address: {
          workflowKey: "target-workflow" as WorkflowKey,
          kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
        },
      },
    });

    const instruction: UndoFileInstruction = {
      path: "src/switch.ts",
      action: "delete",
    };
    const DialogWithHeaderName = () => (
      <UndoChangesDialog
        mode={UNDO_REDO_DIRECTIONS.UNDO}
        intent={UNDO_DIALOG_INTENTS.VIEW}
        target={queueTarget}
        workflowKey={workflowKey}
        runRef={runRef}
        requestId="switch-display-name"
        onClose={vi.fn()}
        workflowEntries={[
          {
            target: queueTarget,
            label: "Step 1",
            undoCandidates: [
              {
                path: instruction.path,
                changeType: "created" as const,
                tier: "tier1" as const,
                instruction,
              },
            ],
          },
        ]}
        workflowName={useWorkflowDisplayName()}
      />
    );

    render(<DialogWithHeaderName />);
    expect(screen.getByText("Target workflow · 1 file")).toBeInTheDocument();
    expect(screen.queryByText("Previous workflow")).not.toBeInTheDocument();
  });

  it("keeps blocked-only changes visible and keeps the header count equal to dialog rows", () => {
    useUiStore.setState({
      displayedViewAddress: {
        workflowKey,
        kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
        runRef,
      },
      pendingRunViewSwitch: null,
    });
    const target = { kind: FINAL_STEP_PHASES.QUEUE, index: 0 } as const;
    const { result } = renderHook(() =>
      useOutputUndoActions({
        allMessages: [
          {
            type: "cli",
            target,
            timestamp: 1,
            data: { isStreaming: false },
          } as never,
        ],
        allowUndoActions: true,
        finalStepWorkspaceSnapshots: {},
        historyOutputs: null,
        isViewingHistory: false,
        lastCliIndexPerStep: new Map([["queue:0", 0]]),
        stepOutputsMap: new Map([["queue:0", []]]),
        undoRecords: {},
        uniqueStepTargets: [target],
        workspaceSnapshots: {
          0: {
            capturedAt: 1,
            strategy: "filesystem",
            changedFiles: ["one", "two", "three"].map((name) => ({
              path: `src/${name}.ts`,
              changeType: FILE_OPERATION_KINDS.MODIFIED,
            })),
          },
        },
      })
    );

    act(() => result.current.handleWorkflowView());
    const workflowDialogState = result.current.workflowDialogState;
    if (!workflowDialogState) throw new Error("workflow dialog did not open");

    render(
      <>
        <OutputSectionHeader
          activeOutputTab={OUTPUT_TABS.OUTPUT}
          activeTerminalSession={null}
          anyDiffCollapsed={false}
          hasOutput
          hiddenOutputCount={0}
          isFindOpen={false}
          isExecutionActive={false}
          isFullscreen={false}
          isHeaderNarrow={false}
          isHeaderVeryNarrow={false}
          isTerminalCompact={false}
          refCallback={vi.fn()}
          showTerminalTab={false}
          terminalCanCloseActiveSession={false}
          terminalExecutionRunLabel={null}
          terminalFontSize={14}
          terminalSessionActive={false}
          useCompactLabels={false}
          workflowChangeSummary={result.current.workflowChangeSummary}
          onCollapseAllDiffs={vi.fn()}
          onExpandAllDiffs={vi.fn()}
          onExport={vi.fn()}
          onToggleFind={vi.fn()}
          onClearHiddenOutputTargets={vi.fn()}
          onNewTerminal={vi.fn()}
          onSelectOutputTab={vi.fn()}
          onSelectTerminalTab={vi.fn()}
          onToggleFullscreen={vi.fn()}
          onTerminalFontSizeChange={vi.fn()}
          onTerminalSessionClose={vi.fn()}
          onToggleCollapse={vi.fn()}
          onWorkflowView={vi.fn()}
          outputFontSize={14}
          onOutputFontSizeChange={vi.fn()}
        />
        <UndoChangesDialog
          mode={workflowDialogState.mode}
          intent={workflowDialogState.intent}
          target={workflowDialogState.entries[0]!.target}
          workflowKey={workflowDialogState.address.workflowKey}
          runRef={workflowDialogState.address.runRef}
          requestId={workflowDialogState.requestId}
          onClose={vi.fn()}
          workflowEntries={workflowDialogState.entries}
          workflowName={workflowDialogState.workflowName}
        />
      </>
    );

    const rowCount = screen.getAllByText("Cannot undo").length;
    expect(
      screen.getByRole("button", { name: "View 3 changes" })
    ).toBeInTheDocument();
    expect(result.current.workflowChangeSummary.total).toBe(rowCount);
    expect(rowCount).toBe(3);
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

  it("shows only the files still available to redo in a step record", () => {
    const remainingRedo: UndoFileInstruction = {
      path: "src/B.ts",
      action: "restore-content",
      contentToRestore: "AI version",
    };

    render(
      <UndoChangesDialog
        mode="redo"
        target={queueTarget}
        workflowKey={workflowKey}
        runRef={runRef}
        workspacePath="C:/dev/ctrlyoke"
        requestId="remaining-redo-files"
        onClose={vi.fn()}
        workflowEntries={[
          {
            target: queueTarget,
            label: "Step 1",
            redoInstructions: [remainingRedo],
          },
        ]}
      />
    );

    expect(screen.getByLabelText("src/B.ts")).toBeInTheDocument();
    expect(screen.queryByLabelText("src/A.ts")).not.toBeInTheDocument();
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

    fireEvent.click(screen.getByRole("button", { name: "Undo 1 file" }));
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

  it("sends fetched snapshot restore content in an undo request", () => {
    const instruction: UndoFileInstruction = {
      path: "src/deleted.ts",
      action: "restore-content",
      contentToRestore: "fetched original file",
    };
    const input = {
      scope: { mode: "prompt" as const, target: queueTarget },
      eventAttributedFiles: [],
      snapshotOnlyFiles: [],
      workspacePath: "C:/dev/ctrlyoke",
    };
    sendMessageMock.mockClear();

    render(
      <UndoChangesDialog
        mode="undo"
        target={queueTarget}
        workflowKey={workflowKey}
        runRef={runRef}
        workspacePath={input.workspacePath}
        input={input}
        requestId="undo-fetched-snapshot-content"
        onClose={vi.fn()}
        workflowEntries={[
          {
            target: queueTarget,
            label: "Step 1",
            undoCandidates: [
              {
                path: instruction.path,
                changeType: "deleted",
                tier: "tier2",
                instruction,
              },
            ],
          },
        ]}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Undo 1 file" }));
    expect(sendMessageMock).toHaveBeenCalledWith(
      MESSAGE_TYPES.UNDO_WORKFLOW_CHANGES,
      {
        data: {
          requestId: "undo-fetched-snapshot-content",
          workflowKey,
          runRef,
          entries: [{ target: queueTarget, files: [instruction] }],
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

    fireEvent.click(screen.getByRole("button", { name: "Redo 1 file" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Undo 1 file" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Redo 1 file" }));
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

  it("selects and confirms all 100 workflow files, including unmounted rows", () => {
    const entries = [
      {
        target: queueTarget,
        label: "Large step",
        undoCandidates: Array.from({ length: 100 }, (_unused, index) => {
          const path = `src/file-${index}.ts`;
          const instruction: UndoFileInstruction = {
            path,
            action: "delete",
          };
          return {
            path,
            changeType: "created" as const,
            tier: "tier1" as const,
            instruction,
          };
        }),
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
        requestId="workflow-large-select-all"
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText("100 of 100 files selected")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Deselect all" }));
    expect(
      screen.getByRole("button", { name: "Select all" })
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    fireEvent.click(screen.getByRole("button", { name: "Undo 100 files" }));

    const message = sendMessageMock.mock.calls[0]?.[1] as {
      data: { entries: Array<{ files: UndoFileInstruction[] }> };
    };
    expect(message.data.entries).toHaveLength(1);
    expect(message.data.entries[0]?.files).toHaveLength(100);
    expect(message.data.entries[0]?.files[99]?.path).toBe("src/file-99.ts");
  });

  it("sends workflow redo steps oldest first", () => {
    const entries = [0, 1, 2].map((stepIndex) => ({
      target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex },
      label: `Step ${stepIndex + 1}`,
      redoInstructions: [
        {
          path: `src/file-${stepIndex}.ts`,
          action: "restore-content" as const,
          contentToRestore: `step ${stepIndex}`,
        },
      ],
    }));

    render(
      <UndoChangesDialog
        mode="redo"
        target={queueTarget}
        workflowKey={workflowKey}
        runRef={runRef}
        workspacePath="C:/dev/ctrlyoke"
        workflowEntries={entries}
        requestId="workflow-redo-order"
        onClose={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Redo 3 files" }));
    const message = sendMessageMock.mock.calls[0]?.[1] as {
      data: { entries: Array<{ target: { stepIndex: number } }> };
    };
    expect(message.data.entries.map((entry) => entry.target.stepIndex)).toEqual(
      [0, 1, 2]
    );
  });

  it("renders one aggregated workflow row and sends undo steps newest first", () => {
    const base = "base\n";
    const stepOne = "step one\n";
    const entries = [
      {
        target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
        label: "Step 1",
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
        label: "Step 3",
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
    expect(screen.getByText("Step 1, Step 3")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Undo 1 file" }));
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
