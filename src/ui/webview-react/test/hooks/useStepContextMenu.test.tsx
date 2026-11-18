import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStepContextMenu } from "@hooks/useStepContextMenu";
import { EXECUTION_STATES, MESSAGE_TYPES, STEP_TYPES } from "@/types/messages";
import type { WorkflowStep, CliOutput } from "@store/workflowStore";
import { useExecutionPreviewStore } from "@store/executionPreviewStore";
import { useUiStore } from "@store/uiStore";
import { useWorkflowStore } from "@store/workflowStore";
import { useEditorStore } from "@store/editorStore";
import { useSettingsStore } from "@store/settingsStore";
import {
  FINAL_STEP_PHASES,
  HARNESS_IDS,
  HEADLESS_STEER_DELIVERIES,
  OUTPUT_HISTORY_KINDS,
  SESSION_KINDS,
  STEP_STATUS,
  TERMINAL_SESSION_STATUS,
} from "@/types/messages";
import { useTerminalStore } from "@store/terminalStore";

function TestHarness({
  step,
  pendingRewind,
  direction = "forward",
  latestOutput,
  runtimeMeta,
  parallelGroups = [],
  totalSteps = 2,
  currentStep = 0,
  deleteIndex = 0,
  executionState = EXECUTION_STATES.IDLE,
  isExternallyManaged = false,
  confirmDeleteOperations = false,
}: {
  step: WorkflowStep;
  pendingRewind?: { fromStepIndex: number };
  direction?: "rewind" | "forward";
  latestOutput?: CliOutput | null;
  runtimeMeta?: { sessionId?: string; elapsed?: number };
  parallelGroups?: Array<{
    id: string;
    startIndex: number;
    endIndex: number;
    failFast: boolean;
  }>;
  totalSteps?: number;
  currentStep?: number;
  deleteIndex?: number;
  executionState?: (typeof EXECUTION_STATES)[keyof typeof EXECUTION_STATES];
  isExternallyManaged?: boolean;
  confirmDeleteOperations?: boolean;
}) {
  const { openContextMenu, contextMenuPortal, deleteModal } =
    useStepContextMenu({
      isExternallyManaged,
      canChangeStartPosition: true,
      canPasteStep: true,
      executionState,
      confirmResetOperations: false,
      confirmDeleteOperations,
      totalSteps,
      currentStep,
      pendingRewind,
      parallelGroups,
    });

  return (
    <>
      <button
        onClick={() =>
          openContextMenu(20, 20, {
            step,
            setPositionTarget: 1,
            deleteIndex,
            isCurrentStep: deleteIndex === currentStep,
            isExecutionTargetLocked: false,
            direction,
            latestOutput,
            runtimeMeta,
          })
        }
      >
        Open menu
      </button>
      {contextMenuPortal}
      {deleteModal}
    </>
  );
}

describe("useStepContextMenu", () => {
  const readText = vi.fn();
  const writeText = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    useWorkflowStore.getState().resetWorkflow();
    useWorkflowStore.temporal.getState().clear();
    useUiStore.getState().resetUi();
    useExecutionPreviewStore.getState().reset();
    useEditorStore.getState().resetEditor();
    useSettingsStore.getState().resetSettings();
    readText.mockReset();
    writeText.mockClear();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        readText,
        writeText,
      },
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the queue-step menu in the required order with dividers", () => {
    render(<TestHarness step={{ prompt: "Original prompt" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));

    expect(
      screen.getByRole("menuitem", { name: "Paste Step" })
    ).not.toBeDisabled();

    const labels = screen
      .getAllByRole("menuitem")
      .map((button) => button.textContent?.trim());

    expect(labels).toEqual([
      "Select All",
      "Copy Step",
      "Copy Prompt",
      "Copy Response",
      "Copy Transcript",
      "Copy Metadata",
      "Reply to Step",
      "Hide output",
      "Show only this step's output",
      "Dry Run Step",
      "Paste Step",
      "Set Start Position",
      "Move Up",
      "Move Down",
      "Disable",
      "Delete",
    ]);
    expect(screen.getAllByRole("separator")).toHaveLength(6);
    expect(
      screen.getByRole("menuitem", { name: "Reply to Step" })
    ).toBeDisabled();
  });

  it("offers selection actions and preserves the current selection when opening on another row", () => {
    useWorkflowStore.getState().loadWorkflow({
      fileName: "test.prompt.md",
      steps: [{ prompt: "One" }, { prompt: "Two" }],
    });
    useEditorStore
      .getState()
      .selectPrompt(
        { kind: "queue", index: 1 },
        useWorkflowStore.getState().steps[1]
      );
    render(<TestHarness step={{ prompt: "One" }} deleteIndex={0} />);
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));

    expect(
      screen.getByRole("menuitem", { name: "Select All" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Select to Here" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Add to Selection" })
    ).toBeInTheDocument();
    expect(useEditorStore.getState().selectionTarget).toEqual({
      kind: "queue",
      index: 1,
    });

    fireEvent.click(screen.getByRole("menuitem", { name: "Add to Selection" }));
    expect(useEditorStore.getState().multiSelection?.indices).toEqual([0, 1]);
  });

  it("offers remove and clear actions only for a multi-selection", () => {
    useWorkflowStore.getState().loadWorkflow({
      fileName: "test.prompt.md",
      steps: [{ prompt: "One" }, { prompt: "Two" }, { prompt: "Three" }],
    });
    useEditorStore.getState().selectAllSteps();
    render(<TestHarness step={{ prompt: "One" }} deleteIndex={0} />);
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));

    fireEvent.click(
      screen.getByRole("menuitem", { name: "Remove from Selection" })
    );
    expect(useEditorStore.getState().multiSelection?.indices).toEqual([1, 2]);

    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Clear Selection" }));
    expect(useEditorStore.getState().multiSelection).toBeNull();
  });

  it("offers bulk enable/disable and delete with counts for a selected row", () => {
    useWorkflowStore.getState().loadWorkflow({
      fileName: "test.prompt.md",
      steps: [{ prompt: "One" }, { prompt: "Two", enabled: false }],
    });
    useEditorStore.getState().selectAllSteps();
    render(<TestHarness step={{ prompt: "One" }} totalSteps={2} />);
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));

    expect(
      screen.getByRole("menuitem", { name: "Disable 2 steps" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Delete 2 steps" })
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "Disable 2 steps" }));
    expect(window.vscodeApi?.postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.UPDATE_STEPS,
      indices: [0, 1],
      properties: { enabled: false },
    });
  });

  it("shows the bulk delete confirmation with the selection count", () => {
    useWorkflowStore.getState().loadWorkflow({
      fileName: "test.prompt.md",
      steps: [{ prompt: "One" }, { prompt: "Two" }],
    });
    useEditorStore.getState().selectAllSteps();
    render(
      <TestHarness
        step={{ prompt: "One" }}
        totalSteps={2}
        confirmDeleteOperations={true}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete 2 steps" }));

    expect(screen.getAllByText("Delete 2 steps?")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(window.vscodeApi?.postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.DELETE_PROMPT,
      indices: [0, 1],
    });
    expect(useEditorStore.getState().multiSelection).toBeNull();
  });

  it("disables bulk actions with a reason and selection fix", () => {
    useWorkflowStore.getState().loadWorkflow({
      fileName: "test.prompt.md",
      steps: [
        { prompt: "Done", _runtime: { completedAt: Date.now() } },
        { prompt: "Pending" },
      ],
    });
    useEditorStore.getState().selectAllSteps();
    render(<TestHarness step={{ prompt: "Done" }} totalSteps={2} />);
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));

    for (const label of ["Disable 2 steps", "Delete 2 steps"]) {
      expect(screen.getByRole("menuitem", { name: label })).toBeDisabled();
      expect(
        screen.getByRole("menuitem", { name: label }).getAttribute("title")
      ).toContain("Remove completed or running steps from the selection");
    }
  });

  it("switches the output action to Show output when the step is hidden", () => {
    useUiStore.getState().toggleHiddenOutputTarget("_shell", "queue:0");

    render(<TestHarness step={{ prompt: "Original prompt" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));

    expect(
      screen.queryByRole("button", { name: "Hide output" })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Show output" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Show only this step's output" })
    ).toBeInTheDocument();
  });

  it("disables Move Up at the front of the queue and omits both for a done step", () => {
    render(<TestHarness step={{ prompt: "Original prompt" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));

    expect(screen.getByRole("menuitem", { name: "Move Up" })).toBeDisabled();
    expect(
      screen.getByRole("menuitem", { name: "Move Down" })
    ).not.toBeDisabled();
  });

  it("moves a selected block up once and remaps its indices", () => {
    useWorkflowStore.getState().loadWorkflow({
      fileName: "bulk-reorder.prompt.md",
      steps: [
        { prompt: "One" },
        { prompt: "Two" },
        { prompt: "Three" },
        { prompt: "Four" },
      ],
    });
    useEditorStore.setState({
      multiSelection: { indices: [1, 3], anchorIndex: 3 },
    });
    render(
      <TestHarness step={{ prompt: "Two" }} totalSteps={4} deleteIndex={1} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Move Up" }));

    expect(window.vscodeApi?.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MESSAGE_TYPES.REORDER_PROMPTS,
        newPendingOrder: [1, 3, 0, 2],
      })
    );
    expect(useEditorStore.getState().multiSelection).toEqual({
      indices: [0, 1],
      anchorIndex: 1,
    });
  });

  it("moves a selected block down once and remaps its indices", () => {
    useWorkflowStore.getState().loadWorkflow({
      fileName: "bulk-reorder.prompt.md",
      steps: [
        { prompt: "One" },
        { prompt: "Two" },
        { prompt: "Three" },
        { prompt: "Four" },
      ],
    });
    useEditorStore.setState({
      multiSelection: { indices: [0, 2], anchorIndex: 0 },
    });
    render(
      <TestHarness step={{ prompt: "Three" }} totalSteps={4} deleteIndex={2} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Move Down" }));

    expect(window.vscodeApi?.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MESSAGE_TYPES.REORDER_PROMPTS,
        newPendingOrder: [1, 0, 2, 3],
      })
    );
    expect(useEditorStore.getState().multiSelection).toEqual({
      indices: [1, 2],
      anchorIndex: 1,
    });
  });

  it("omits Move Up/Down for a rewind-direction (done) step", () => {
    render(<TestHarness step={{ prompt: "Done prompt" }} direction="rewind" />);
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));

    expect(
      screen.queryByRole("button", { name: "Move Up" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Move Down" })
    ).not.toBeInTheDocument();
  });

  it("disables mutation items for the executed prefix with a reason tooltip", () => {
    render(
      <TestHarness
        step={{ prompt: "Completed", _runtime: { completedAt: Date.now() } }}
        direction="rewind"
        currentStep={1}
        deleteIndex={0}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));

    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "Delete" })).toHaveAttribute(
      "title",
      "Cannot change a completed step"
    );
    expect(screen.getByRole("menuitem", { name: "Disable" })).toBeDisabled();
  });

  it("disables preserved-prefix deletion during a pending rewind", () => {
    render(
      <TestHarness
        step={{ prompt: "Preserved" }}
        pendingRewind={{ fromStepIndex: 1 }}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));

    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "Delete" })).toHaveAttribute(
      "title",
      "Cannot change a preserved step while a continuation is pending"
    );
  });

  it("switches the content/toggle labels for disabled script steps", () => {
    render(
      <TestHarness
        step={{
          type: STEP_TYPES.SCRIPT,
          script: "echo test",
          enabled: false,
        }}
        latestOutput={{
          scriptOutput: { command: "echo test", stdout: "test", stderr: "" },
          elapsed: 1,
          isStreaming: false,
        }}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));

    expect(
      screen.getByRole("menuitem", { name: "Paste Step" })
    ).not.toBeDisabled();

    expect(
      screen.getByRole("menuitem", { name: "Copy Script" })
    ).toBeInTheDocument();
    // A script has no assistant, so its copy command names its output.
    expect(
      screen.getByRole("menuitem", { name: "Copy Output" })
    ).toHaveAttribute("title", expect.stringContaining("stdout"));
    expect(
      screen.queryByRole("menuitem", { name: "Copy Response" })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Enable" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Reply to Step" })
    ).toBeDisabled();
    expect(
      screen.getByRole("menuitem", { name: "Reply to Step" })
    ).toHaveAttribute("title", "Script steps have no AI session to reply to");
  });

  it("disables Reply to Step when no session ID is available", () => {
    render(<TestHarness step={{ prompt: "Original prompt" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));

    expect(
      screen.getByRole("menuitem", { name: "Reply to Step" })
    ).toBeDisabled();
    expect(
      screen.getByRole("menuitem", { name: "Reply to Step" })
    ).toHaveAttribute("title", "This step has no session to resume yet");
  });

  it("replies with the step session and resolved properties in read-only, running, and history views", () => {
    useUiStore.getState().setHistoryView();
    const sessionId = "queue-session-123";
    const step: WorkflowStep = {
      prompt: "Original prompt",
      _runtime: { harness: "claude-cli", model: "sonnet", sessionId },
    };
    render(
      <TestHarness
        step={step}
        runtimeMeta={{ sessionId }}
        executionState={EXECUTION_STATES.RUNNING}
        isExternallyManaged
        deleteIndex={1}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));

    const replyItem = screen.getByRole("menuitem", { name: "Reply to Step" });
    expect(replyItem).toBeEnabled();
    fireEvent.click(replyItem);

    const editor = useEditorStore.getState();
    expect(editor.properties.resumeSession).toBe(true);
    expect(editor.properties.sessionId).toBe(sessionId);
    expect(editor.properties.harness).toBe("claude-cli");
    expect(editor.replyContext).toMatchObject({
      sessionId,
      harness: "claude-cli",
      sourceLabel: "Step 2",
    });
  });

  describe("live step controls", () => {
    function openHeadlessTarget(
      stepIndex: number,
      canInterruptTurn: boolean | undefined,
      controlSessionId = `control-${stepIndex}`
    ) {
      useTerminalStore.getState().updateHeadlessControlTarget({
        type: MESSAGE_TYPES.HEADLESS_CONTROL_TARGET_CHANGED,
        workflowId: "workflow-1",
        controlSessionId,
        stepIndex,
        harnessId: HARNESS_IDS.CLAUDE_CLI,
        steerDelivery: HEADLESS_STEER_DELIVERIES.INJECT,
        ...(canInterruptTurn !== undefined ? { canInterruptTurn } : {}),
        isOpen: true,
      });
    }

    beforeEach(() => {
      useTerminalStore.setState({
        sessions: {},
        activeSessionIds: {},
        headlessControlTargets: {},
      });
      useUiStore.setState({ activeWorkflowId: "workflow-1" });
      useWorkflowStore.setState({ activeStepIndices: [0, 1] });
    });

    const runningStep: WorkflowStep = {
      prompt: "Running",
      status: STEP_STATUS.RUNNING,
    };

    it("omits both items on a step that is neither running nor live", () => {
      render(<TestHarness step={{ prompt: "Pending" }} />);
      fireEvent.click(screen.getByRole("button", { name: "Open menu" }));

      expect(
        screen.queryByRole("menuitem", { name: "Send Steer to Step" })
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("menuitem", { name: "End Step Early" })
      ).not.toBeInTheDocument();
    });

    it("places both items after Reply to Step on a running step", () => {
      openHeadlessTarget(1, true);
      render(
        <TestHarness step={runningStep} deleteIndex={1} currentStep={0} />
      );
      fireEvent.click(screen.getByRole("button", { name: "Open menu" }));

      const labels = screen
        .getAllByRole("menuitem")
        .map((button) => button.textContent?.trim());
      const replyIndex = labels.indexOf("Reply to Step");
      expect(labels.slice(replyIndex, replyIndex + 3)).toEqual([
        "Reply to Step",
        "Send Steer to Step",
        "End Step Early",
      ]);
    });

    it("steers the editor draft to the pressed step, not the lowest one", () => {
      openHeadlessTarget(0, true);
      openHeadlessTarget(1, true);
      useEditorStore.setState({ promptText: "  focus on tests  " });
      render(
        <TestHarness step={runningStep} deleteIndex={1} currentStep={0} />
      );
      fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
      fireEvent.click(
        screen.getByRole("menuitem", { name: "Send Steer to Step" })
      );

      expect(window.vscodeApi?.postMessage).toHaveBeenCalledWith({
        type: MESSAGE_TYPES.SEND_STEER_MESSAGE,
        workflowId: "workflow-1",
        sessionId: "control-1",
        text: "focus on tests",
      });
      expect(useEditorStore.getState().promptText).toBe("");
    });

    it("disables Send Steer to Step without an editor draft", () => {
      openHeadlessTarget(1, true);
      useEditorStore.setState({ promptText: "" });
      render(
        <TestHarness step={runningStep} deleteIndex={1} currentStep={0} />
      );
      fireEvent.click(screen.getByRole("button", { name: "Open menu" }));

      expect(
        screen.getByRole("menuitem", { name: "Send Steer to Step" })
      ).toBeDisabled();
    });

    it("offers Send Steer to Step on a finished step with a retained terminal", () => {
      useWorkflowStore.setState({ activeStepIndices: [] });
      useTerminalStore.setState({
        sessions: {
          "workflow-1": [
            {
              id: "pty-0",
              workflowId: "workflow-1",
              stepName: "Step 1",
              stepIndex: 0,
              kind: SESSION_KINDS.AI_CLI,
              harnessId: HARNESS_IDS.CLAUDE_CLI,
              status: TERMINAL_SESSION_STATUS.RUNNING,
              isController: true,
            },
          ],
        },
      });
      useEditorStore.setState({ promptText: "follow up" });
      render(
        <TestHarness
          step={{ prompt: "Done", status: STEP_STATUS.COMPLETED }}
          deleteIndex={0}
          currentStep={1}
          direction="rewind"
        />
      );
      fireEvent.click(screen.getByRole("button", { name: "Open menu" }));

      expect(
        screen.getByRole("menuitem", { name: "Send Steer to Step" })
      ).toBeEnabled();
      expect(
        screen.queryByRole("menuitem", { name: "End Step Early" })
      ).not.toBeInTheDocument();
    });

    it("ends the pressed step early through its own control session", () => {
      openHeadlessTarget(0, true);
      openHeadlessTarget(1, true);
      render(
        <TestHarness step={runningStep} deleteIndex={1} currentStep={0} />
      );
      fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
      const endItem = screen.getByRole("menuitem", { name: "End Step Early" });
      expect(endItem).toHaveAttribute(
        "title",
        "Stops step 2's current turn, keeps its output so far, and continues the workflow."
      );
      fireEvent.click(endItem);

      expect(window.vscodeApi?.postMessage).toHaveBeenCalledWith({
        type: MESSAGE_TYPES.INTERRUPT_HEADLESS_TURN,
        workflowId: "workflow-1",
        sessionId: "control-1",
      });
    });

    it.each([
      ["no control target", undefined, false],
      ["a target that cannot interrupt", false, true],
    ] as const)(
      "disables End Step Early with %s",
      (_label, canInterruptTurn, hasTarget) => {
        if (hasTarget) openHeadlessTarget(1, canInterruptTurn);
        render(
          <TestHarness step={runningStep} deleteIndex={1} currentStep={0} />
        );
        fireEvent.click(screen.getByRole("button", { name: "Open menu" }));

        const endItem = screen.getByRole("menuitem", {
          name: "End Step Early",
        });
        expect(endItem).toBeDisabled();
        expect(endItem).toHaveAttribute(
          "title",
          "End Step Early needs a headless Claude Code, Codex or Qwen step"
        );
      }
    );
  });

  it("opens a step-scoped Dry Run from the step menu", () => {
    render(<TestHarness step={{ prompt: "Original prompt" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Dry Run Step" }));

    expect(useExecutionPreviewStore.getState().scope).toEqual({
      kind: "step",
      stepIndex: 0,
    });
  });

  it("copies resolved execution properties for a pending step with no output yet", async () => {
    render(<TestHarness step={{ prompt: "Original prompt" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));

    const copyMetadataButton = screen.getByRole("menuitem", {
      name: "Copy Metadata",
    });
    expect(copyMetadataButton).not.toBeDisabled();
    fireEvent.click(copyMetadataButton);

    expect(writeText).toHaveBeenCalledTimes(1);
    const copiedText = writeText.mock.calls[0][0] as string;
    expect(copiedText).toContain("Prompt step 1");
    expect(copiedText).toContain("Execution properties:");
    expect(copiedText).toContain("harness:");
    expect(copiedText).toContain("model:");
  });

  it("includes the attempt prompt in copied full output markdown", () => {
    const latestOutput: CliOutput = {
      structured: {
        events: [{ type: "text", data: { text: "step response" } }],
        metadata: {},
      },
      elapsed: 1,
      isStreaming: false,
    };
    useWorkflowStore.setState({
      liveOrderedEntries: [
        {
          kind: OUTPUT_HISTORY_KINDS.CLI,
          target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
          attemptIndex: 0,
          prompt: "the actual attempt prompt",
          cliOutput: latestOutput,
          timestampMs: 1,
          sequence: 1,
        },
      ],
    });
    render(
      <TestHarness
        step={{ prompt: "Original prompt" }}
        latestOutput={latestOutput}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy Transcript" }));

    const copiedText = writeText.mock.calls[0][0] as string;
    expect(copiedText).toContain("### Prompt");
    expect(copiedText).toContain("the actual attempt prompt");
  });

  it("copies the running step's session ID and token/usage data before completion", () => {
    render(
      <TestHarness
        step={{ prompt: "Original prompt" }}
        latestOutput={{
          structured: {
            events: [{ type: "text", data: { text: "" } }],
            metadata: {},
          },
          elapsed: 4.2,
          isStreaming: true,
          tokens: {
            prompt: 1000,
            completion: 500,
            total: 1500,
            cached: 200,
            contextWindowUsed: 12000,
            contextWindowSize: 200000,
            compactionCount: 1,
          },
        }}
        runtimeMeta={{ sessionId: "abc123-session" }}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy Metadata" }));

    const copiedText = writeText.mock.calls[0][0] as string;
    expect(copiedText).toContain("Session ID: abc123-session");
    expect(copiedText).toContain("Current context window:");
    expect(copiedText).toContain("Attempt total:");
    expect(copiedText).toContain("Compactions: 1");
  });

  it("adds discard continuation only at the rewind boundary", () => {
    render(
      <TestHarness
        step={{ prompt: "Boundary prompt" }}
        pendingRewind={{ fromStepIndex: 0 }}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));

    expect(
      screen.getByRole("menuitem", { name: "Discard Continuation" })
    ).toBeInTheDocument();
  });

  it("groups an ungrouped step with its next neighbor", () => {
    useWorkflowStore.getState().loadWorkflow({
      fileName: "test.prompt.md",
      steps: [{ prompt: "one" }, { prompt: "two" }],
    });
    render(<TestHarness step={{ prompt: "one" }} totalSteps={2} />);
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Group with next step" })
    );

    expect(window.vscodeApi?.postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.REORDER_PROMPTS,
      newPendingOrder: [0, 1],
      pendingGroups: [{ start: 0, end: 1, failFast: true }],
    });
  });

  it("ungroups a pending group through the shared reorder message", () => {
    const parallelGroups = [
      { id: "group-1", startIndex: 0, endIndex: 1, failFast: false },
    ];
    useWorkflowStore.getState().loadWorkflow({
      fileName: "test.prompt.md",
      steps: [{ prompt: "one" }, { prompt: "two" }],
      parallelGroups,
    });
    render(
      <TestHarness
        step={{ prompt: "one" }}
        parallelGroups={parallelGroups}
        totalSteps={2}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Ungroup parallel steps" })
    );

    expect(window.vscodeApi?.postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.REORDER_PROMPTS,
      newPendingOrder: [0, 1],
      pendingGroups: [],
    });
  });

  it("disables grouping into a settled neighbor group instead of sending a merge the server would reject", () => {
    const parallelGroups = [
      { id: "group-1", startIndex: 0, endIndex: 1, failFast: true },
    ];
    // currentStep=1 sits inside the group's own range, which is exactly what
    // makes it settled: `isParallelGroupTopologyLocked` treats any group
    // whose startIndex is behind currentStep as already executed.
    const steps: WorkflowStep[] = [
      { prompt: "one" },
      { prompt: "two" },
      { prompt: "three" },
    ];
    useWorkflowStore.getState().loadWorkflow({
      fileName: "test.prompt.md",
      steps,
      parallelGroups,
    });
    render(
      <TestHarness
        step={steps[2]}
        parallelGroups={parallelGroups}
        totalSteps={3}
        currentStep={1}
        deleteIndex={2}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));

    const groupWithPrevious = screen.getByRole("menuitem", {
      name: "Group with previous step",
    });
    expect(groupWithPrevious).toBeDisabled();

    const callsBefore = (window.vscodeApi?.postMessage as any).mock.calls
      .length;
    fireEvent.click(groupWithPrevious);
    expect((window.vscodeApi?.postMessage as any).mock.calls.length).toBe(
      callsBefore
    );
  });

  it("disables grouping the currently executing step with its next neighbor", () => {
    const steps: WorkflowStep[] = [{ prompt: "one" }, { prompt: "two" }];
    useWorkflowStore.getState().loadWorkflow({
      fileName: "test.prompt.md",
      steps,
    });
    render(
      <TestHarness
        step={steps[0]}
        totalSteps={2}
        currentStep={0}
        deleteIndex={0}
        executionState={EXECUTION_STATES.RUNNING}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));

    const groupWithNext = screen.getByRole("menuitem", {
      name: "Group with next step",
    });
    expect(groupWithNext).toBeDisabled();

    const callsBefore = (window.vscodeApi?.postMessage as any).mock.calls
      .length;
    fireEvent.click(groupWithNext);
    expect((window.vscodeApi?.postMessage as any).mock.calls.length).toBe(
      callsBefore
    );
  });
});
