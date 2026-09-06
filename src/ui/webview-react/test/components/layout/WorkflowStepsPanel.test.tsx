import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowStepsPanel } from "@components/layout/WorkflowStepsPanel";
import {
  buildPendingDragState,
  buildPendingReorderPayload,
  movePendingDragItem,
  resolvePendingDragEnd,
} from "@components/layout/WorkflowStepsPanel";
import { ExecutingStepHighlight } from "@components/prompts/ExecutingStepHighlight";
import { useEditorStore } from "@store/editorStore";
import { useSettingsStore } from "@store/settingsStore";
import { useUiStore } from "@store/uiStore";
import { useWorkflowStore } from "@store/workflowStore";
import { FINAL_STEP_PHASES, MESSAGE_TYPES } from "@/types/messages";
import { EXECUTION_STATES, STEP_STATUS } from "@/types/messages";
import {
  HARNESS_CHART_COLORS,
  HARNESS_IDS,
  STEP_COLOR_TIE_BREAK_PALETTE,
} from "@root/types/DashboardConstants";
import { resolveStepColor } from "@utils/stepColor";

function resetStores() {
  useWorkflowStore.getState().resetWorkflow();
  useWorkflowStore.temporal.getState().clear();
  useEditorStore.getState().resetEditor();
  useSettingsStore.getState().resetSettings();
  useUiStore.getState().resetUi();
  useUiStore.setState({
    stepsCollapsed: false,
    finalStepFooterExpanded: false,
    loadedWorkflows: [],
    activeWorkflowId: null,
    isViewingHistory: false,
  });
}

function loadSelectedWorkflow() {
  useWorkflowStore.getState().loadWorkflow({
    fileName: "test.prompt.md",
    steps: [{ prompt: "Selected step" }],
  });

  const step = useWorkflowStore.getState().steps[0];
  useEditorStore
    .getState()
    .selectPrompt({ kind: FINAL_STEP_PHASES.QUEUE, index: 0 }, step);
}

describe("WorkflowStepsPanel keyboard shortcuts", () => {
  const readText = vi.fn();
  const writeText = vi.fn();
  const postMessage = vi.fn();

  beforeEach(() => {
    resetStores();
    loadSelectedWorkflow();

    readText.mockReset();
    writeText.mockReset();
    postMessage.mockReset();

    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        readText,
        writeText,
      },
    });

    Object.defineProperty(window, "vscodeApi", {
      configurable: true,
      value: {
        postMessage,
        getState: vi.fn(() => null),
        setState: vi.fn(),
      },
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("copies the selected queue step when Ctrl+C is pressed on the steps list", async () => {
    writeText.mockResolvedValue(undefined);

    render(<WorkflowStepsPanel />);
    const listbox = screen.getByRole("listbox");

    fireEvent.keyDown(listbox, { key: "c", ctrlKey: true });

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(JSON.parse(writeText.mock.calls[0][0])).toEqual({
      prompt: "Selected step",
    });
  });

  it("pastes after the selected queue step when Ctrl+V is pressed on the steps list", async () => {
    readText.mockResolvedValue(JSON.stringify({ prompt: "Pasted step" }));

    render(<WorkflowStepsPanel />);
    const listbox = screen.getByRole("listbox");

    fireEvent.keyDown(listbox, { key: "v", ctrlKey: true });

    await waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith({
        type: MESSAGE_TYPES.INSERT_WORKFLOW_STEP,
        afterIndex: 0,
        step: { prompt: "Pasted step" },
      })
    );
  });

  it("does not intercept Ctrl+C from textarea targets inside the steps panel", () => {
    render(<WorkflowStepsPanel />);
    const listbox = screen.getByRole("listbox");
    const textarea = document.createElement("textarea");
    listbox.appendChild(textarea);

    fireEvent.keyDown(textarea, {
      key: "c",
      ctrlKey: true,
      bubbles: true,
    });

    expect(writeText).not.toHaveBeenCalled();
  });

  it("renders disabled steps and disabled final-step state without mutating status", () => {
    resetStores();
    useWorkflowStore.getState().loadWorkflow({
      fileName: "test.prompt.md",
      steps: [{ prompt: "Disabled step", enabled: false }],
      finalStep: { prompt: "Disabled final step", enabled: false },
    });
    useUiStore.setState({ finalStepFooterExpanded: true });

    render(<WorkflowStepsPanel />);

    expect(screen.getByText("Disabled step")).toBeInTheDocument();
    expect(screen.getAllByText("Disabled").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("disabled")).toBeInTheDocument();
    expect(screen.getAllByLabelText("disabled").length).toBeGreaterThanOrEqual(
      2
    );
  });

  it("shows execution mode badges only for explicit step overrides", () => {
    resetStores();
    useWorkflowStore.getState().loadWorkflow({
      fileName: "test.prompt.md",
      steps: [
        { prompt: "Inherited mode" },
        { prompt: "Interactive mode", executionMode: "interactive" },
        { prompt: "Headless mode", executionMode: "headless" },
      ],
    });

    render(<WorkflowStepsPanel />);

    expect(
      screen.queryByTitle("executionMode: undefined")
    ).not.toBeInTheDocument();

    const interactiveBadge = screen.getByTitle("executionMode: interactive");
    expect(
      interactiveBadge.querySelector(".codicon-debug-console")
    ).not.toBeNull();

    const headlessBadge = screen.getByTitle("executionMode: headless");
    expect(headlessBadge.querySelector(".codicon-terminal")).not.toBeNull();
  });

  it("disables the final step without deleting it", async () => {
    resetStores();
    useWorkflowStore.getState().loadWorkflow({
      fileName: "test.prompt.md",
      steps: [{ prompt: "Queued step" }],
      finalStep: { prompt: "Final step" },
    });

    render(<WorkflowStepsPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Disable final step" }));

    await waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith({
        type: MESSAGE_TYPES.UPDATE_FINAL_PROMPT,
        finalStep: {
          prompt: "Final step",
          enabled: false,
        },
      })
    );
  });

  it("selects a running final step for editing", () => {
    resetStores();
    useWorkflowStore.getState().loadWorkflow({
      fileName: "test.prompt.md",
      steps: [{ prompt: "Queued step" }],
      executionState: EXECUTION_STATES.RUNNING,
      currentStep: 1,
      finalStep: { prompt: "Running final step" },
      finalStepStatus: STEP_STATUS.RUNNING,
      finalStepPhase: FINAL_STEP_PHASES.FINAL_STEP,
    });

    render(<WorkflowStepsPanel />);

    fireEvent.click(screen.getByText("Final Step"));

    expect(useEditorStore.getState().isFinalStepMode()).toBe(true);
    expect(useEditorStore.getState().promptText).toBe("Running final step");
  });

  it("shows detailed status counts in the header tooltip and keeps the divider unlabeled", () => {
    resetStores();
    useWorkflowStore.getState().loadWorkflow({
      fileName: "test.prompt.md",
      steps: [
        { prompt: "Completed step" },
        { prompt: "Failed step" },
        { prompt: "Skipped step" },
        { prompt: "Running step" },
        { prompt: "Pending step" },
      ],
      executionState: EXECUTION_STATES.RUNNING,
      currentStep: 3,
      results: [
        { status: STEP_STATUS.COMPLETED },
        { status: STEP_STATUS.FAILED },
        { status: STEP_STATUS.SKIPPED },
      ],
    });

    render(<WorkflowStepsPanel />);

    expect(
      screen.getByTitle(
        "Completed: 1 | Failed: 1 | Skipped: 1 | Cancelled: 0 | Running: 1 | Sent: 0 | Pending: 1"
      )
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/completed .* failed .* skipped/i)
    ).not.toBeInTheDocument();
  });

  it("renders the running-step accent as one animated four-sided overlay", () => {
    resetStores();
    useWorkflowStore.getState().loadWorkflow({
      fileName: "test.prompt.md",
      steps: [{ prompt: "Running step" }, { prompt: "Pending step" }],
      executionState: EXECUTION_STATES.RUNNING,
      currentStep: 0,
    });

    render(<WorkflowStepsPanel />);

    const highlight = screen.getByTestId("executing-step-highlight");
    expect(highlight).toHaveClass(
      "border-2",
      "border-status-idle",
      "animate-pulse-custom",
      "inset-0"
    );
    expect(highlight).not.toHaveAttribute("style");
    expect(
      screen.getByText("Running step").closest("[data-workflow-step-index]")
    ).toHaveAttribute("data-workflow-step-index", "0");
  });

  it("renders a thinner running-step overlay around the collapsed chip", () => {
    resetStores();
    useWorkflowStore.getState().loadWorkflow({
      fileName: "test.prompt.md",
      steps: [{ prompt: "Completed step" }, { prompt: "Running step" }],
      executionState: EXECUTION_STATES.RUNNING,
      currentStep: 1,
      results: [{ status: STEP_STATUS.COMPLETED }],
    });
    useUiStore.setState({ stepsCollapsed: true });

    render(<WorkflowStepsPanel />);

    const highlight = screen.getByTestId("executing-chip-highlight");
    expect(highlight).toHaveClass(
      "border",
      "border-status-idle",
      "animate-pulse-custom",
      "inset-0"
    );
    expect(highlight).not.toHaveClass("border-2");
    expect(highlight).not.toHaveAttribute("style");
    expect(
      document.querySelector('[data-workflow-chip-index="1"]')
    ).toBeInTheDocument();
  });

  it("renders a yellow pause boundary before the next full-size step", () => {
    resetStores();
    useWorkflowStore.getState().loadWorkflow({
      fileName: "test.prompt.md",
      steps: [{ prompt: "Completed step" }, { prompt: "Continue here" }],
      executionState: EXECUTION_STATES.PAUSED,
      currentStep: 1,
      results: [{ status: STEP_STATUS.COMPLETED }],
    });

    render(<WorkflowStepsPanel />);

    const boundary = screen.getByTestId("pause-boundary");
    expect(boundary).toHaveClass(
      "h-[2px]",
      "bg-[var(--status-warning)]",
      "top-0"
    );
    expect(boundary.closest("[data-workflow-step-index]")).toHaveAttribute(
      "data-workflow-step-index",
      "1"
    );
    expect(screen.getByLabelText(STEP_STATUS.COMPLETED)).toBeInTheDocument();
  });

  it("renders the same pause boundary before the next collapsed chip", () => {
    resetStores();
    useWorkflowStore.getState().loadWorkflow({
      fileName: "test.prompt.md",
      steps: [{ prompt: "Completed step" }, { prompt: "Continue here" }],
      executionState: EXECUTION_STATES.PAUSED,
      currentStep: 1,
      results: [{ status: STEP_STATUS.COMPLETED }],
    });
    useUiStore.setState({ stepsCollapsed: true });

    render(<WorkflowStepsPanel />);

    const boundary = screen.getByTestId("pause-boundary");
    expect(
      boundary.closest('[data-workflow-chip-index="1"]')
    ).toBeInTheDocument();
    expect(boundary).toHaveClass("inset-y-0", "left-0", "w-[2px]");
  });

  it("renders the execution highlight without measured inline geometry", () => {
    render(<ExecutingStepHighlight />);

    const highlight = screen.getByTestId("executing-step-highlight");
    expect(highlight).toHaveClass("absolute", "inset-0");
    expect(highlight).not.toHaveAttribute("style");
  });

  it("does not render the execution highlight while the workflow is idle", () => {
    resetStores();
    useWorkflowStore.getState().loadWorkflow({
      fileName: "test.prompt.md",
      steps: [{ prompt: "Idle step" }],
      executionState: EXECUTION_STATES.IDLE,
      currentStep: 0,
    });

    render(<WorkflowStepsPanel />);

    expect(
      screen.queryByTestId("executing-step-highlight")
    ).not.toBeInTheDocument();
  });

  it("uses the same centered number styling for completed and executing steps", () => {
    resetStores();
    useWorkflowStore.getState().loadWorkflow({
      fileName: "test.prompt.md",
      steps: [{ prompt: "Completed step" }, { prompt: "Running step" }],
      executionState: EXECUTION_STATES.RUNNING,
      currentStep: 1,
      results: [{ status: STEP_STATUS.COMPLETED }],
    });

    render(<WorkflowStepsPanel />);

    for (const number of ["1", "2"]) {
      expect(screen.getByText(number)).toHaveClass(
        "w-[26px]",
        "justify-center",
        "text-sm"
      );
    }
  });

  it("shows compact runtime stats for failed steps", () => {
    resetStores();
    useWorkflowStore.getState().loadWorkflow({
      fileName: "test.prompt.md",
      steps: [
        {
          prompt: "Failed step",
          _runtime: { elapsed: 12.3, sessionId: "session-abc123" },
        } as any,
        { prompt: "Current step" },
      ],
      executionState: EXECUTION_STATES.RUNNING,
      currentStep: 1,
      results: [{ status: STEP_STATUS.FAILED }],
    });

    render(<WorkflowStepsPanel />);

    expect(screen.getByText("12.3s")).toBeInTheDocument();
    expect(screen.getByText("abc123")).toBeInTheDocument();
  });

  it("shows a continuation message for failed steps that the workflow moved past", () => {
    resetStores();
    useWorkflowStore.getState().loadWorkflow({
      fileName: "test.prompt.md",
      steps: [
        {
          prompt: "Failed step",
          _runtime: { failureMessage: "Rate limited by harness" },
        } as any,
        { prompt: "Current step" },
      ],
      executionState: EXECUTION_STATES.RUNNING,
      currentStep: 1,
      results: [{ status: STEP_STATUS.FAILED }],
    });

    render(<WorkflowStepsPanel />);

    expect(
      screen.getByText(
        "Workflow continued after failure: Rate limited by harness"
      )
    ).toBeInTheDocument();
  });

  it("does not show a continuation message when an error stops on the last step", () => {
    resetStores();
    useWorkflowStore.getState().loadWorkflow({
      fileName: "test.prompt.md",
      steps: [
        {
          prompt: "Failed final step",
          _runtime: { failureMessage: "Rate limited by harness" },
        } as any,
      ],
      executionState: EXECUTION_STATES.ERROR,
      currentStep: 1,
      results: [{ status: STEP_STATUS.FAILED }],
    });

    render(<WorkflowStepsPanel />);

    expect(
      screen.queryByText(/Workflow continued after failure/)
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Workflow continued after this step failed/)
    ).not.toBeInTheDocument();
  });

  it("does not show a continuation message when an error stops before the next step", () => {
    resetStores();
    useWorkflowStore.getState().loadWorkflow({
      fileName: "test.prompt.md",
      steps: [
        {
          prompt: "Failed step",
          _runtime: { failureMessage: "Rate limited by harness" },
        } as any,
        { prompt: "Pending step" },
      ],
      executionState: EXECUTION_STATES.ERROR,
      currentStep: 1,
      results: [{ status: STEP_STATUS.FAILED }],
    });

    render(<WorkflowStepsPanel />);

    expect(
      screen.queryByText(/Workflow continued after failure/)
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Workflow continued after this step failed/)
    ).not.toBeInTheDocument();
  });

  it("only shows the failed icon on the step that errored, not the next pending step", () => {
    resetStores();
    useWorkflowStore.getState().loadWorkflow({
      fileName: "test.prompt.md",
      steps: [{ prompt: "Failed step" }, { prompt: "Pending step" }],
      executionState: EXECUTION_STATES.ERROR,
      currentStep: 1,
      results: [{ status: STEP_STATUS.FAILED }],
    });

    render(<WorkflowStepsPanel />);

    expect(screen.getAllByLabelText(STEP_STATUS.FAILED)).toHaveLength(1);
    expect(screen.getByLabelText(STEP_STATUS.PENDING)).toBeInTheDocument();
  });

  it("lets not-yet-run steps be dragged during a run while pinning the running and completed steps", () => {
    resetStores();
    useWorkflowStore.getState().loadWorkflow({
      fileName: "test.prompt.md",
      steps: [
        { prompt: "Done step" },
        { prompt: "Running step" },
        { prompt: "Pending A" },
        { prompt: "Pending B" },
      ],
      executionState: EXECUTION_STATES.RUNNING,
      currentStep: 1,
      results: [{ status: STEP_STATUS.COMPLETED }],
    });

    render(<WorkflowStepsPanel />);

    // Only the two pending steps after the running step expose a drag handle.
    expect(screen.getAllByLabelText("Drag to reorder")).toHaveLength(2);

    // The running step (current) and the completed step cannot be dragged.
    const runningRow = screen
      .getByText("Running step")
      .closest("[data-workflow-step-index]") as HTMLElement;
    expect(
      within(runningRow).queryByLabelText("Drag to reorder")
    ).not.toBeInTheDocument();
    const doneRow = screen
      .getByText("Done step")
      .closest("[data-workflow-step-index]") as HTMLElement;
    expect(
      within(doneRow).queryByLabelText("Drag to reorder")
    ).not.toBeInTheDocument();
  });

  it("keeps every pending step draggable when idle", () => {
    resetStores();
    useWorkflowStore.getState().loadWorkflow({
      fileName: "test.prompt.md",
      steps: [{ prompt: "Step 1" }, { prompt: "Step 2" }, { prompt: "Step 3" }],
      executionState: EXECUTION_STATES.IDLE,
      currentStep: 0,
    });

    render(<WorkflowStepsPanel />);

    expect(screen.getAllByLabelText("Drag to reorder")).toHaveLength(3);
  });

  it("shows a getting-started CTA when no steps are loaded and posts NEW_WORKFLOW on click", () => {
    resetStores();

    render(<WorkflowStepsPanel />);

    expect(screen.getByText("No workflow steps yet")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Create from Template" })
    );

    expect(postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.NEW_WORKFLOW,
    });
  });
});

describe("WorkflowStepsPanel grouped drag model", () => {
  const steps = [
    { prompt: "one" },
    { prompt: "two" },
    { prompt: "three" },
    { prompt: "four" },
  ];
  const groups = [
    { id: "group-1", startIndex: 1, endIndex: 2, failFast: false },
  ];

  it("moves a step between outer containers", () => {
    const initial = buildPendingDragState(steps, 0, []);
    const next = movePendingDragItem(
      initial,
      "step-pending-0",
      "step-pending-3"
    );

    expect(buildPendingReorderPayload(next, 0, [])).toEqual({
      newPendingOrder: [1, 2, 3, 0],
      pendingGroups: [],
    });
  });

  it("moves a step into a group container", () => {
    const initial = buildPendingDragState(steps, 0, groups);
    const next = movePendingDragItem(
      initial,
      "step-pending-0",
      "group-group-1"
    );

    expect(buildPendingReorderPayload(next, 0, groups)).toEqual({
      newPendingOrder: [1, 2, 0, 3],
      pendingGroups: [{ id: "group-1", start: 0, end: 2, failFast: false }],
    });
  });

  it("moves a member between group containers", () => {
    const initial = buildPendingDragState(
      [
        { prompt: "one" },
        { prompt: "two" },
        { prompt: "three" },
        { prompt: "four" },
        { prompt: "five" },
      ],
      0,
      [
        { id: "group-1", startIndex: 1, endIndex: 2, failFast: true },
        { id: "group-2", startIndex: 3, endIndex: 4, failFast: false },
      ]
    );
    const next = movePendingDragItem(
      initial,
      "step-pending-1",
      "group-group-2"
    );

    expect(
      buildPendingReorderPayload(next, 0, [
        { id: "group-1", startIndex: 1, endIndex: 2, failFast: true },
        { id: "group-2", startIndex: 3, endIndex: 4, failFast: false },
      ])
    ).toEqual({
      newPendingOrder: [0, 2, 3, 4, 1],
      pendingGroups: [{ id: "group-2", start: 2, end: 4, failFast: false }],
    });
  });

  // `handleDragOver` commits cross-container moves optimistically, so the
  // drag-end decision cannot ask whether the *local* state changed — for an
  // ungrouped step (its own container) it never does, and the reorder was
  // silently dropped: the list re-ordered on screen and nothing was sent.
  it("emits a payload for a top-level reorder that dragOver already applied", () => {
    const committed = buildPendingDragState(steps, 0, []);
    const dragged = movePendingDragItem(
      committed,
      "step-pending-1",
      "step-pending-2"
    );

    const outcome = resolvePendingDragEnd(
      dragged,
      committed,
      "step-pending-1",
      "step-pending-2",
      0,
      []
    );

    expect(outcome?.payload).toEqual({
      newPendingOrder: [0, 2, 1, 3],
      pendingGroups: [],
    });
  });

  it("emits nothing when a drag ends on the committed topology", () => {
    const committed = buildPendingDragState(steps, 0, groups);

    expect(
      resolvePendingDragEnd(
        committed,
        committed,
        "step-pending-1",
        "step-pending-1",
        0,
        groups
      )
    ).toBeUndefined();
  });

  it("emits a payload when a member is dropped into a different group", () => {
    const committed = buildPendingDragState(steps, 0, groups);
    const dragged = movePendingDragItem(
      committed,
      "step-pending-3",
      "group-group-1"
    );

    const outcome = resolvePendingDragEnd(
      dragged,
      committed,
      "step-pending-3",
      "group-group-1",
      0,
      groups
    );

    expect(outcome?.payload.pendingGroups).toEqual([
      { id: "group-1", start: 1, end: 3, failFast: false },
    ]);
  });

  it("moves a member out of a group and unwraps the remainder", () => {
    const initial = buildPendingDragState(steps, 0, groups);
    const next = movePendingDragItem(
      initial,
      "step-pending-1",
      "step-pending-3"
    );

    expect(buildPendingReorderPayload(next, 0, groups)).toEqual({
      newPendingOrder: [0, 2, 1, 3],
      pendingGroups: [],
    });
  });
});

describe("WorkflowStepsPanel identity rails", () => {
  beforeEach(() => {
    resetStores();
  });

  afterEach(() => {
    cleanup();
  });

  /** Resolve a CSS colour to the form jsdom stores on an inline style. */
  function normalizeColor(value: string): string {
    const probe = document.createElement("div");
    probe.style.backgroundColor = value;
    return probe.style.backgroundColor;
  }

  it("applies group tie-break colors to a completed member of an unfinished parallel group", () => {
    // ParallelGroupPanel only takes over once every member is done, so a group
    // that is still running renders its finished members through the panel's
    // own completed-step branch. That branch must still supply group context,
    // or the same step is coloured differently here than in the output pane.
    const group = {
      id: "group-identity-rails",
      startIndex: 0,
      endIndex: 1,
      failFast: false,
    };
    const runtime = { harness: HARNESS_IDS.CLAUDE_CLI };
    const steps = [
      { prompt: "first member", _runtime: runtime },
      { prompt: "second member", _runtime: runtime },
      { prompt: "after the group" },
    ];

    useWorkflowStore.getState().loadWorkflow({
      fileName: "test.prompt.md",
      steps,
      parallelGroups: [group],
      currentStep: 1,
    });

    render(<WorkflowStepsPanel />);

    const rail = document.querySelector(
      '[data-workflow-step-index="0"] > div:first-child'
    ) as HTMLElement | null;
    expect(rail).not.toBeNull();

    const withGroupContext = resolveStepColor({
      step: steps[0],
      harnessId: HARNESS_IDS.CLAUDE_CLI,
      group,
      offsetInGroup: 0,
      groupMembers: [
        { step: steps[0], harnessId: HARNESS_IDS.CLAUDE_CLI, offsetInGroup: 0 },
        { step: steps[1], harnessId: HARNESS_IDS.CLAUDE_CLI, offsetInGroup: 1 },
      ],
    });

    expect(STEP_COLOR_TIE_BREAK_PALETTE).toContain(withGroupContext);
    expect(rail?.style.backgroundColor).toBe(
      normalizeColor(withGroupContext as string)
    );
    // Without the group the resolver would hand back the bare harness colour,
    // which is exactly the mismatch this call site used to produce.
    expect(rail?.style.backgroundColor).not.toBe(
      normalizeColor(HARNESS_CHART_COLORS[HARNESS_IDS.CLAUDE_CLI])
    );
  });
});
