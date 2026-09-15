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
  hasTrailingPendingGroup,
  isParallelGroupDragMove,
  movePendingDragContainer,
  movePendingDragItem,
  pendingDragCollisionDetection,
  resolvePendingDragEnd,
} from "@components/layout/WorkflowStepsPanel";
import { PENDING_TAIL_DRAG_ID } from "@utils/dndKit";
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
  STEP_COLOR_MODES,
} from "@root/types/DashboardConstants";
import { getUniqueStepColor, resolveStepColor } from "@utils/stepColor";

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

    fireEvent.click(screen.getByRole("button", { name: "Final step" }));

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
    // Horizontal, like the expanded panel's: the chip's left edge already
    // belongs to its identity colour bar, which a vertical boundary painted
    // over in yellow.
    expect(boundary).toHaveClass("inset-x-0", "top-0", "h-[2px]");
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
  const leadingGroups = [
    { id: "group-1", startIndex: 0, endIndex: 1, failFast: false },
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

  it("moves a step into a group by dropping it on a member", () => {
    const initial = buildPendingDragState(steps, 0, groups);
    const next = movePendingDragItem(
      initial,
      "step-pending-0",
      "step-pending-2"
    );

    expect(buildPendingReorderPayload(next, 0, groups)).toEqual({
      newPendingOrder: [1, 0, 2, 3],
      pendingGroups: [{ id: "group-1", start: 0, end: 2, failFast: false }],
    });
  });

  // The reported bug: a group pinned to the top of the list left a step no
  // reachable slot above it, because every drop over the group resolved to one
  // of its members and absorbed the step into it.
  it("moves a step above a leading group when dropped on the group itself", () => {
    const initial = buildPendingDragState(steps, 0, leadingGroups);
    const next = movePendingDragItem(
      initial,
      "step-pending-2",
      "group-group-1"
    );

    expect(buildPendingReorderPayload(next, 0, leadingGroups)).toEqual({
      newPendingOrder: [2, 0, 1, 3],
      pendingGroups: [{ id: "group-1", start: 1, end: 2, failFast: false }],
    });
  });

  it("moves a member between group containers", () => {
    const twoGroups = [
      { id: "group-1", startIndex: 1, endIndex: 2, failFast: true },
      { id: "group-2", startIndex: 3, endIndex: 4, failFast: false },
    ];
    const initial = buildPendingDragState(
      [
        { prompt: "one" },
        { prompt: "two" },
        { prompt: "three" },
        { prompt: "four" },
        { prompt: "five" },
      ],
      0,
      twoGroups
    );
    const next = movePendingDragItem(
      initial,
      "step-pending-1",
      "step-pending-3"
    );

    expect(buildPendingReorderPayload(next, 0, twoGroups)).toEqual({
      newPendingOrder: [0, 2, 1, 3, 4],
      pendingGroups: [{ id: "group-2", start: 2, end: 4, failFast: false }],
    });
  });

  it("drags a whole group to another top-level slot", () => {
    const initial = buildPendingDragState(steps, 0, groups);
    const next = movePendingDragContainer(
      initial,
      "group-group-1",
      "step-pending-3"
    );

    expect(buildPendingReorderPayload(next, 0, groups)).toEqual({
      newPendingOrder: [0, 3, 1, 2],
      pendingGroups: [{ id: "group-1", start: 2, end: 3, failFast: false }],
    });
  });

  it("resolves a group drop inside another group to that group's slot", () => {
    const initial = buildPendingDragState(steps, 0, leadingGroups);
    const next = movePendingDragContainer(
      initial,
      "step-pending-3",
      "step-pending-1"
    );

    expect(buildPendingReorderPayload(next, 0, leadingGroups)).toEqual({
      newPendingOrder: [3, 0, 1, 2],
      pendingGroups: [{ id: "group-1", start: 1, end: 2, failFast: false }],
    });
  });

  // A same-level drag leaves the rendered list alone while the pointer is
  // down (`isParallelGroupDragMove` is false), so drag end both applies the
  // move and emits it. It also cannot ask whether the *local* state changed:
  // for an ungrouped step (its own container) a group crossing never does,
  // and the reorder used to be silently dropped — the list re-ordered on
  // screen and nothing was sent.
  it("applies and emits a top-level reorder on drop", () => {
    const committed = buildPendingDragState(steps, 0, []);

    const outcome = resolvePendingDragEnd(
      committed,
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

  it("only folds a drag into the in-flight state when it crosses a group", () => {
    const committed = buildPendingDragState(steps, 0, groups);

    // Plain sibling reorders, including one that lands beside the group.
    expect(
      isParallelGroupDragMove(committed, "step-pending-0", "step-pending-3")
    ).toBe(false);
    expect(
      isParallelGroupDragMove(committed, "step-pending-0", "group-group-1")
    ).toBe(false);
    // Joining a group, and leaving one.
    expect(
      isParallelGroupDragMove(committed, "step-pending-0", "step-pending-2")
    ).toBe(true);
    expect(
      isParallelGroupDragMove(committed, "step-pending-1", "step-pending-3")
    ).toBe(true);
    // Reordering inside the group the step already belongs to, and dragging
    // the group itself, both stay out of it.
    expect(
      isParallelGroupDragMove(committed, "step-pending-1", "step-pending-2")
    ).toBe(false);
    expect(
      isParallelGroupDragMove(committed, "group-group-1", "step-pending-3")
    ).toBe(false);
  });

  it("does not re-apply a group crossing that dragOver already folded in", () => {
    const committed = buildPendingDragState(steps, 0, groups);
    const dragged = movePendingDragItem(
      committed,
      "step-pending-0",
      "step-pending-2"
    );

    const outcome = resolvePendingDragEnd(
      dragged,
      committed,
      "step-pending-0",
      "step-pending-2",
      0,
      groups
    );

    expect(outcome?.payload).toEqual(
      buildPendingReorderPayload(dragged, 0, groups)
    );
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
      "step-pending-1"
    );

    const outcome = resolvePendingDragEnd(
      dragged,
      committed,
      "step-pending-3",
      "step-pending-1",
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

  it("pulls a member out of its group when dropped on the group's own slot", () => {
    const initial = buildPendingDragState(steps, 0, groups);
    const next = movePendingDragItem(
      initial,
      "step-pending-2",
      "group-group-1"
    );

    expect(buildPendingReorderPayload(next, 0, groups)).toEqual({
      newPendingOrder: [0, 2, 1, 3],
      pendingGroups: [],
    });
  });

  // A group at the *end* of the list has no slot below it: its own id means the
  // position it already occupies, and it keeps that position when a step leaves
  // it, so a drop there inserts the step in front of the group. The tail is the
  // only id that means "after everything".
  describe("trailing group", () => {
    // Steps 0-1 are ungrouped; the group holds 2-3 and ends the list.
    const trailingGroups = [
      { id: "group-1", startIndex: 2, endIndex: 3, failFast: false },
    ];

    it("is the only container that needs a tail slot", () => {
      expect(
        hasTrailingPendingGroup(buildPendingDragState(steps, 0, trailingGroups))
      ).toBe(true);
      expect(
        hasTrailingPendingGroup(buildPendingDragState(steps, 0, groups))
      ).toBe(false);
      expect(hasTrailingPendingGroup(buildPendingDragState(steps, 0, []))).toBe(
        false
      );
    });

    it("takes a step below it when the step is dropped on the tail", () => {
      const initial = buildPendingDragState(steps, 0, trailingGroups);
      const next = movePendingDragItem(
        initial,
        "step-pending-0",
        PENDING_TAIL_DRAG_ID
      );

      expect(buildPendingReorderPayload(next, 0, trailingGroups)).toEqual({
        newPendingOrder: [1, 2, 3, 0],
        pendingGroups: [{ id: "group-1", start: 1, end: 2, failFast: false }],
      });
    });

    // The reported bug. Dragging a step down past a trailing group folds it
    // into the group on the way, so by the time the pointer clears the last
    // member the step's container *is* the group — and dropping on the group's
    // own slot from there put it back above the group, with no way to reach the
    // other side.
    it("releases a step it has already absorbed to the slot below it", () => {
      const committed = buildPendingDragState(steps, 0, trailingGroups);
      const folded = movePendingDragItem(
        committed,
        "step-pending-0",
        "step-pending-3"
      );

      const outcome = resolvePendingDragEnd(
        folded,
        committed,
        "step-pending-0",
        PENDING_TAIL_DRAG_ID,
        0,
        trailingGroups
      );

      expect(outcome?.payload).toEqual({
        newPendingOrder: [1, 2, 3, 0],
        pendingGroups: [{ id: "group-1", start: 1, end: 2, failFast: false }],
      });
    });

    it("dissolves when the tail takes its second-to-last member", () => {
      const initial = buildPendingDragState(steps, 0, trailingGroups);
      const next = movePendingDragItem(
        initial,
        "step-pending-2",
        PENDING_TAIL_DRAG_ID
      );

      expect(buildPendingReorderPayload(next, 0, trailingGroups)).toEqual({
        newPendingOrder: [0, 1, 3, 2],
        pendingGroups: [],
      });
    });

    // Folding is what keeps the dragged row animated: `over` is an outer id
    // while the row still lives in the group's nested sortable context, and
    // `useSortable` drops every transform when the two disagree.
    it("counts a member leaving for the tail as a group crossing", () => {
      const committed = buildPendingDragState(steps, 0, trailingGroups);

      expect(
        isParallelGroupDragMove(
          committed,
          "step-pending-2",
          PENDING_TAIL_DRAG_ID
        )
      ).toBe(true);
      // An ungrouped step heading for the tail is a plain top-level reorder,
      // which the sorting strategy animates without any mutation.
      expect(
        isParallelGroupDragMove(
          committed,
          "step-pending-0",
          PENDING_TAIL_DRAG_ID
        )
      ).toBe(false);
    });

    it("leaves a step already at the tail where it is", () => {
      const initial = buildPendingDragState(steps, 0, trailingGroups);
      const atTail = movePendingDragItem(
        initial,
        "step-pending-0",
        PENDING_TAIL_DRAG_ID
      );

      expect(
        movePendingDragItem(atTail, "step-pending-0", PENDING_TAIL_DRAG_ID)
      ).toEqual(atTail);
    });
  });
});

describe("WorkflowStepsPanel pending drag collision detection", () => {
  const steps = [{ prompt: "one" }, { prompt: "two" }, { prompt: "three" }];
  // A group holding steps 0-1 sits at the top of the list; step 2 follows it.
  const leadingGroups = [
    { id: "group-1", startIndex: 0, endIndex: 1, failFast: false },
  ];
  const state = buildPendingDragState(steps, 0, leadingGroups);

  function rect(top: number, height: number) {
    return {
      top,
      bottom: top + height,
      left: 0,
      right: 100,
      width: 100,
      height,
    };
  }

  // Header 0-30, members 30-90 and 90-150, then the ungrouped step 150-210.
  const droppableRects = new Map<string, ReturnType<typeof rect>>([
    ["group-group-1", rect(0, 150)],
    ["step-pending-0", rect(30, 60)],
    ["step-pending-1", rect(90, 60)],
    ["step-pending-2", rect(150, 60)],
  ]);
  const droppableContainers = [...droppableRects.keys()].map((id) => ({ id }));

  function firstCollisionFor(activeId: string, draggedTop: number) {
    const detect = pendingDragCollisionDetection(state);
    const collisions = detect({
      active: { id: activeId },
      collisionRect: rect(draggedTop, 60),
      droppableRects,
      droppableContainers,
      pointerCoordinates: null,
    } as never);
    return collisions[0] ? String(collisions[0].id) : undefined;
  }

  it("targets the group itself when a step is dragged over its header", () => {
    // Dragged centre at 0 — above the first member row, so the step belongs
    // beside the group rather than inside it. Plain closestCenter reports the
    // member here, which is why a leading group could not be dragged past.
    expect(firstCollisionFor("step-pending-2", -30)).toBe("group-group-1");
  });

  it("targets the group itself when a step is dragged past its last member", () => {
    expect(firstCollisionFor("step-pending-2", 120)).toBe("group-group-1");
  });

  it("still targets a member when the step is dragged over the members", () => {
    // Centre at 60 — squarely on the first member row.
    expect(firstCollisionFor("step-pending-2", 30)).toBe("step-pending-0");
  });

  it("offers a dragged group only top-level slots, never its own members", () => {
    // The group's members sit under the pointer for the whole drag; reporting
    // one would put `over` outside the outer list and kill every transform.
    expect(firstCollisionFor("group-group-1", 30)).toBe("step-pending-2");
  });

  describe("with the group at the end of the list", () => {
    const trailingSteps = [
      { prompt: "one" },
      { prompt: "two" },
      { prompt: "three" },
      { prompt: "four" },
    ];
    const trailingGroups = [
      { id: "group-1", startIndex: 2, endIndex: 3, failFast: false },
    ];
    const trailingState = buildPendingDragState(
      trailingSteps,
      0,
      trailingGroups
    );

    // Two ungrouped rows (0-60, 60-120), then the group at 120-270: header
    // 120-150, members 150-210 and 210-270, and the tail slot just under it.
    const trailingRects = new Map<string, ReturnType<typeof rect>>([
      ["step-pending-0", rect(0, 60)],
      ["step-pending-1", rect(60, 60)],
      ["group-group-1", rect(120, 150)],
      ["step-pending-2", rect(150, 60)],
      ["step-pending-3", rect(210, 60)],
      [PENDING_TAIL_DRAG_ID, rect(270, 8)],
    ]);

    function trailingCollisionFor(activeId: string, draggedTop: number) {
      const detect = pendingDragCollisionDetection(trailingState);
      const collisions = detect({
        active: { id: activeId },
        collisionRect: rect(draggedTop, 60),
        droppableRects: trailingRects,
        droppableContainers: [...trailingRects.keys()].map((id) => ({ id })),
        pointerCoordinates: null,
      } as never);
      return collisions[0] ? String(collisions[0].id) : undefined;
    }

    it("targets the tail when a step is dragged past the last member", () => {
      // Centre at 270 — clear of the group. The group's own slot would mean
      // "above the group" here, since the group keeps its place in the order
      // when a step leaves it.
      expect(trailingCollisionFor("step-pending-0", 240)).toBe(
        PENDING_TAIL_DRAG_ID
      );
    });

    it("still targets the group itself over its header", () => {
      // Centre at 140 — above the first member row, so still "beside it".
      expect(trailingCollisionFor("step-pending-0", 110)).toBe("group-group-1");
    });

    it("keeps the tail out of the collisions it did not ask for", () => {
      // Centre at 265, inside the last member's own row: the tail's centre is
      // nearer, so plain closestCenter would report it and steal the bottom of
      // a row that is still a perfectly good place to join the group.
      expect(trailingCollisionFor("step-pending-0", 235)).toBe(
        "step-pending-3"
      );
    });

    it("never offers the tail to a dragged group", () => {
      // A group reaches every slot through its top-level neighbours, so the
      // tail would only be a second id for a position it can already take.
      expect(trailingCollisionFor("group-group-1", 240)).toBe("step-pending-1");
    });
  });
});
describe("WorkflowStepsPanel parallel group boundaries", () => {
  const group = {
    id: "group-boundary",
    startIndex: 0,
    endIndex: 1,
    failFast: false,
  };

  beforeEach(() => {
    resetStores();
  });

  afterEach(() => {
    cleanup();
  });

  it("outlines the member that is still running, not the one at the boundary", () => {
    // The state a run reached when one member of a live group settled first
    // and the boundary was published as the settled count: step 2 is done,
    // step 1 is still going, and `currentStep` sits between them. The panel
    // outlined whichever step it found at `currentStep`, which is how the row
    // showing a completed check ended up wearing the running outline — and how
    // the group container disappeared on the way.
    useWorkflowStore.getState().loadWorkflow({
      fileName: "test.prompt.md",
      steps: [{ prompt: "still running" }, { prompt: "settled first" }],
      parallelGroups: [group],
      executionState: EXECUTION_STATES.RUNNING,
      currentStep: 1,
      activeStepIndices: [0],
      results: [
        { status: STEP_STATUS.RUNNING },
        { status: STEP_STATUS.COMPLETED },
      ],
    });

    render(<WorkflowStepsPanel />);

    expect(
      screen
        .getByTestId("executing-step-highlight")
        .closest("[data-workflow-step-index]")
    ).toHaveAttribute("data-workflow-step-index", "0");
    expect(
      screen.getByTestId(`parallel-group-${group.id}`)
    ).toBeInTheDocument();
  });

  it("draws a group the done/pending boundary runs through as one container", () => {
    // Reachable without a run: `Set Start Position` onto a group's second
    // member leaves the anchor settled and the rest pending. Split across the
    // two sections the group had no container at all and simply vanished.
    useWorkflowStore.getState().loadWorkflow({
      fileName: "test.prompt.md",
      steps: [
        { prompt: "settled member" },
        { prompt: "pending member" },
        { prompt: "after the group" },
      ],
      parallelGroups: [group],
      currentStep: 1,
      results: [{ status: STEP_STATUS.COMPLETED }],
    });

    render(<WorkflowStepsPanel />);

    const container = screen.getByTestId(`parallel-group-${group.id}`);
    expect(within(container).getByText("settled member")).toBeInTheDocument();
    expect(within(container).getByText("pending member")).toBeInTheDocument();
    // The step below the group keeps its own slot number — the pending list
    // skips the group's members rather than renumbering from the boundary.
    expect(
      screen.getByText("after the group").closest("[data-workflow-step-index]")
    ).toHaveAttribute("data-workflow-step-index", "2");
  });

  it("keeps a group the boundary runs through out of the pending drag order", () => {
    const state = buildPendingDragState(
      [
        { prompt: "settled member" },
        { prompt: "pending member" },
        { prompt: "after the group" },
      ],
      1,
      [group]
    );

    // No container for the group (its anchor is behind the boundary) and no
    // loose row for its pending member either: a reorder payload is relative
    // to `currentStep` and could not describe half a container.
    expect(state.order).toEqual(["step-pending-2"]);
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
    // A group is drawn as one container from its anchor, wherever the
    // done/pending boundary happens to sit, so its members always resolve
    // their colour with group context — the same context the output pane has.
    // Without it the same step reads as a bare harness colour in one pane and
    // a tie-break colour in the other.
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

    useSettingsStore.getState().setGlobalSettings({
      ...useSettingsStore.getState().globalSettings,
      stepColorMode: STEP_COLOR_MODES.UNIQUE,
    });

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
      stepIndex: 0,
      group,
      offsetInGroup: 0,
      groupMembers: [
        { step: steps[0], harnessId: HARNESS_IDS.CLAUDE_CLI, offsetInGroup: 0 },
        { step: steps[1], harnessId: HARNESS_IDS.CLAUDE_CLI, offsetInGroup: 1 },
      ],
    });

    expect(withGroupContext).toBe(getUniqueStepColor(0));
    expect(rail?.style.backgroundColor).toBe(
      normalizeColor(withGroupContext as string)
    );
    // Without the group the resolver would hand back the bare harness colour,
    // which is exactly the mismatch this call site used to produce.
    expect(rail?.style.backgroundColor).not.toBe(
      normalizeColor(HARNESS_CHART_COLORS[HARNESS_IDS.CLAUDE_CLI])
    );
  });

  it("uses the unique palette in visible step rows", () => {
    useSettingsStore.getState().setGlobalSettings({
      ...useSettingsStore.getState().globalSettings,
      stepColorMode: STEP_COLOR_MODES.UNIQUE,
    });
    useWorkflowStore.getState().loadWorkflow({
      fileName: "test.prompt.md",
      steps: [{ prompt: "First" }, { prompt: "Second" }],
    });

    render(<WorkflowStepsPanel />);

    expect(
      document.querySelector('[data-workflow-step-index="0"] > div:first-child')
    ).toHaveStyle(`background-color: ${getUniqueStepColor(0)}`);
    expect(
      document.querySelector('[data-workflow-step-index="1"] > div:first-child')
    ).toHaveStyle(`background-color: ${getUniqueStepColor(1)}`);
  });
});
