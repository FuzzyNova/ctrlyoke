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
}) {
  const { openContextMenu, contextMenuPortal } = useStepContextMenu({
    isExternallyManaged,
    canChangeStartPosition: true,
    canPasteStep: true,
    executionState,
    confirmResetOperations: false,
    confirmDeleteOperations: false,
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
            outputText: "step output",
            latestOutput,
            runtimeMeta,
          })
        }
      >
        Open menu
      </button>
      {contextMenuPortal}
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
      screen.getByRole("button", { name: "Paste Step" })
    ).not.toBeDisabled();

    const labels = screen
      .getAllByRole("button")
      .slice(1)
      .map((button) => button.textContent?.trim());

    expect(labels).toEqual([
      "Select All",
      "Copy Step",
      "Copy Prompt",
      "Copy Output",
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
      screen.getByRole("button", { name: "Reply to Step" })
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
      screen.getByRole("button", { name: "Select All" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Select to Here" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Add to Selection" })
    ).toBeInTheDocument();
    expect(useEditorStore.getState().selectionTarget).toEqual({
      kind: "queue",
      index: 1,
    });

    fireEvent.click(screen.getByRole("button", { name: "Add to Selection" }));
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
      screen.getByRole("button", { name: "Remove from Selection" })
    );
    expect(useEditorStore.getState().multiSelection?.indices).toEqual([1, 2]);

    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear Selection" }));
    expect(useEditorStore.getState().multiSelection).toBeNull();
  });

  it("switches the output action to Show output when the step is hidden", () => {
    useUiStore.getState().toggleHiddenOutputTarget("_shell", "queue:0");

    render(<TestHarness step={{ prompt: "Original prompt" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));

    expect(
      screen.queryByRole("button", { name: "Hide output" })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Show output" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Show only this step's output" })
    ).toBeInTheDocument();
  });

  it("disables Move Up at the front of the queue and omits both for a done step", () => {
    render(<TestHarness step={{ prompt: "Original prompt" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));

    expect(screen.getByRole("button", { name: "Move Up" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Move Down" })
    ).not.toBeDisabled();
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

    expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete" })).toHaveAttribute(
      "title",
      "Cannot change a completed step"
    );
    expect(screen.getByRole("button", { name: "Disable" })).toBeDisabled();
  });

  it("disables preserved-prefix deletion during a pending rewind", () => {
    render(
      <TestHarness
        step={{ prompt: "Preserved" }}
        pendingRewind={{ fromStepIndex: 1 }}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));

    expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete" })).toHaveAttribute(
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
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));

    expect(
      screen.getByRole("button", { name: "Paste Step" })
    ).not.toBeDisabled();

    expect(
      screen.getByRole("button", { name: "Copy Script" })
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Enable" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Reply to Step" })
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Reply to Step" })
    ).toHaveAttribute("title", "Script steps have no AI session to reply to");
  });

  it("disables Reply to Step when no session ID is available", () => {
    render(<TestHarness step={{ prompt: "Original prompt" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));

    expect(
      screen.getByRole("button", { name: "Reply to Step" })
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Reply to Step" })
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

    const replyItem = screen.getByRole("button", { name: "Reply to Step" });
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

  it("opens a step-scoped Dry Run from the step menu", () => {
    render(<TestHarness step={{ prompt: "Original prompt" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    fireEvent.click(screen.getByRole("button", { name: "Dry Run Step" }));

    expect(useExecutionPreviewStore.getState().scope).toEqual({
      kind: "step",
      stepIndex: 0,
    });
  });

  it("copies resolved execution properties for a pending step with no output yet", async () => {
    render(<TestHarness step={{ prompt: "Original prompt" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));

    const copyMetadataButton = screen.getByRole("button", {
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

  it("copies the running step's session ID and token/usage data before completion", () => {
    render(
      <TestHarness
        step={{ prompt: "Original prompt" }}
        latestOutput={{
          response: "",
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
    fireEvent.click(screen.getByRole("button", { name: "Copy Metadata" }));

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
      screen.getByRole("button", { name: "Discard Continuation" })
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
      screen.getByRole("button", { name: "Group with next step" })
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
      screen.getByRole("button", { name: "Ungroup parallel steps" })
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

    const groupWithPrevious = screen.getByRole("button", {
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

    const groupWithNext = screen.getByRole("button", {
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
