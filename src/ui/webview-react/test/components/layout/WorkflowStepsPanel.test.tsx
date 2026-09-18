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
  computeDisplaySlots,
  computeLivePreviewState,
  describePendingDragState,
  hasTrailingPendingGroup,
  movePendingDragContainer,
  movePendingDragItem,
  pendingDragCollisionDetection,
  resolvePendingDragEnd,
} from "@components/layout/WorkflowStepsPanel";
import {
  PENDING_TAIL_DRAG_ID,
  livePreviewSortingStrategy,
} from "@utils/dndKit";
import { verticalListSortingStrategy } from "@dnd-kit/sortable";
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

  // A group's own id is only ever reached through the "above the first member"
  // re-point, so it has to mean the same thing from either side. Plain
  // `arrayMove` semantics do not: the group's pre-removal index reads as
  // "after the group" for a downward drag, which sent a step dropped on a
  // group's header past the whole group instead of parking it just above.
  it("parks a step immediately above a group whichever way it was dragged", () => {
    const initial = buildPendingDragState(steps, 0, groups);

    // Downward, from the slot right above the group: nothing to do.
    expect(
      buildPendingReorderPayload(
        movePendingDragItem(initial, "step-pending-0", "group-group-1"),
        0,
        groups
      )
    ).toEqual(buildPendingReorderPayload(initial, 0, groups));

    // Upward, from the slot right below it: the step takes the group's place.
    expect(
      buildPendingReorderPayload(
        movePendingDragItem(initial, "step-pending-3", "group-group-1"),
        0,
        groups
      )
    ).toEqual({
      newPendingOrder: [0, 3, 1, 2],
      pendingGroups: [{ id: "group-1", start: 2, end: 3, failFast: false }],
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

  // Every drop resolves through the exact same `computeLivePreviewState` a
  // live preview frame would, applied once against the committed baseline —
  // there is no separate in-flight state to have drifted from it.
  it("applies and emits a top-level reorder on drop", () => {
    const committed = buildPendingDragState(steps, 0, []);

    const outcome = resolvePendingDragEnd(
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

  it("computes the same live preview for a plain sibling move, joining a group, and leaving one", () => {
    const committed = buildPendingDragState(steps, 0, groups);

    // Plain sibling reorders, including one that lands beside the group.
    expect(
      computeLivePreviewState(committed, "step-pending-0", "step-pending-3")
    ).toEqual(
      movePendingDragItem(committed, "step-pending-0", "step-pending-3")
    );
    // Joining a group, and leaving one.
    expect(
      computeLivePreviewState(committed, "step-pending-0", "step-pending-2")
    ).toEqual(
      movePendingDragItem(committed, "step-pending-0", "step-pending-2")
    );
    expect(
      computeLivePreviewState(committed, "step-pending-1", "step-pending-3")
    ).toEqual(
      movePendingDragItem(committed, "step-pending-1", "step-pending-3")
    );
    // Dragging the group itself.
    expect(
      computeLivePreviewState(committed, "group-group-1", "step-pending-3")
    ).toEqual(
      movePendingDragContainer(committed, "group-group-1", "step-pending-3")
    );
  });

  it("emits nothing when a drag ends on the committed topology", () => {
    const committed = buildPendingDragState(steps, 0, groups);

    expect(
      resolvePendingDragEnd(
        committed,
        "step-pending-1",
        "step-pending-1",
        0,
        groups
      )
    ).toBeUndefined();
  });

  // The reported bug: a step folded into a group showed its own stale
  // identity number instead of the slot it now occupies, colliding with a
  // standalone sibling below the group that still showed *its* stale number.
  it("renumbers every row consistently, with no collisions, when a step crosses into a group", () => {
    const sixSteps = [
      { prompt: "one" },
      { prompt: "two" },
      { prompt: "three" },
      { prompt: "four" },
      { prompt: "five" },
      { prompt: "six" },
    ];
    // Group spans steps 1-2 (display "2"-"3"); steps 3, 4, 5 are standalone
    // siblings below it.
    const committed = buildPendingDragState(sixSteps, 0, [
      { id: "group-1", startIndex: 1, endIndex: 2, failFast: false },
    ]);

    // Drag the last step (originally "6") into the group, landing on its
    // first member.
    const preview = computeLivePreviewState(
      committed,
      "step-pending-5",
      "step-pending-1"
    );
    const slots = computeDisplaySlots(preview, 0);

    const numbers = [...slots.values()].sort((a, b) => a - b);
    // Six steps, six distinct sequential slots — no duplicates, no gaps.
    expect(numbers).toEqual([0, 1, 2, 3, 4, 5]);
    // The standalone siblings that used to sit below the group (originally
    // "4" and "5") shift down by one to make room, rather than keeping their
    // stale numbers and colliding with the group's new size.
    expect(slots.get("step-pending-3")).toBe(4);
    expect(slots.get("step-pending-4")).toBe(5);
  });

  it("emits a payload when a member is dropped into a different group", () => {
    const committed = buildPendingDragState(steps, 0, groups);

    const outcome = resolvePendingDragEnd(
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

    // The reported bug (in the old incremental-fold model): dragging a step
    // down past a trailing group and dropping on the tail put it back above
    // the group instead of below it, because the drop re-applied a move on
    // top of a preview that had already moved it. Resolving straight from the
    // committed baseline can't reproduce that class of bug.
    it("releases a step to the slot below the trailing group when dropped on the tail", () => {
      const committed = buildPendingDragState(steps, 0, trailingGroups);

      const outcome = resolvePendingDragEnd(
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

    it("moves a member leaving for the tail through the live preview the same as a plain step", () => {
      const committed = buildPendingDragState(steps, 0, trailingGroups);

      expect(
        computeLivePreviewState(
          committed,
          "step-pending-2",
          PENDING_TAIL_DRAG_ID
        )
      ).toEqual(
        movePendingDragItem(committed, "step-pending-2", PENDING_TAIL_DRAG_ID)
      );
      expect(
        computeLivePreviewState(
          committed,
          "step-pending-0",
          PENDING_TAIL_DRAG_ID
        )
      ).toEqual(
        movePendingDragItem(committed, "step-pending-0", PENDING_TAIL_DRAG_ID)
      );
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

  it("leaves the slot past a non-trailing group's last member to the members", () => {
    // Centre at 150 — level with the ungrouped row that follows the group, so
    // the neighbouring container is already the nearer collision and there is
    // nothing for a re-point to add. Only a *trailing* group has a position
    // below it that no neighbour can express, which is what the tail slot is
    // for (see the trailing-group suite below).
    expect(firstCollisionFor("step-pending-2", 120)).toBe("step-pending-1");
  });

  it("keeps the group's panel-spanning rect out of the member band", () => {
    // The group's own rect covers its header as well as its rows, so its
    // centre (75) sits inside the *first* member's row (30-90) rather than
    // between the two members. Left in `closestCenter` it beat that member on
    // distance across most of the row, and a group id means "beside the
    // group" — which is why a step aimed at the first slot kept being pulled
    // back out of the group instead of landing in it.
    expect(firstCollisionFor("step-pending-2", 45)).toBe("step-pending-0");
    expect(firstCollisionFor("step-pending-2", 60)).toBe("step-pending-0");
  });

  it("still targets a member when the step is dragged over the members", () => {
    // Centre at 60 — squarely on the first member row.
    expect(firstCollisionFor("step-pending-2", 30)).toBe("step-pending-0");
  });

  it("offers a dragged group only top-level slots, never its own members", () => {
    // The group's members sit under the pointer for the whole drag; reporting
    // one would put `over` outside the outer list and kill every transform.
    // Its own container id is offered though — that is what gives the slot it
    // already occupies a band to rest in.
    expect(firstCollisionFor("group-group-1", 30)).toBe("group-group-1");
    // Far below every member, the following step wins on distance.
    expect(firstCollisionFor("group-group-1", 200)).toBe("step-pending-2");
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
      expect(trailingCollisionFor("group-group-1", 240)).not.toBe(
        PENDING_TAIL_DRAG_ID
      );
      // Here the group's own slot is the nearest — it is already last, and its
      // own rect is what lets it rest there instead of being forced onto a
      // neighbour (see the settling suite below).
      expect(trailingCollisionFor("group-group-1", 240)).toBe("group-group-1");
    });
  });

  /**
   * The pieces above are each necessary but none is sufficient on its own: the
   * bug was that the *loop* never settled. Recomputing the live preview moves
   * the dragged row's real DOM node, dnd-kit re-measures, and the next
   * collision at the very same pointer position can resolve somewhere else —
   * so a slot is only usable if holding the pointer still holds the preview
   * still. That is what this walks: the panel's own rules over a modelled
   * layout, one drag position at a time, checking both that the first member
   * slot has a band of its own and that every position in the walk is a fixed
   * point.
   */
  describe("settling over a modelled layout", () => {
    const MEMBER_ROW = 60;
    const GROUP_HEADER = 30;
    const walkSteps = [
      { prompt: "one" },
      { prompt: "two" },
      { prompt: "three" },
    ];

    /** Rects for the list as the live preview currently has it arranged. */
    function layoutOf(state: ReturnType<typeof buildPendingDragState>) {
      const rects = new Map<string, ReturnType<typeof rect>>();
      let y = 0;
      for (const containerId of state.order) {
        const container = state.containers[containerId];
        if (!container) continue;
        if (container.groupId) {
          const top = y;
          y += GROUP_HEADER;
          for (const item of container.items) {
            rects.set(item, rect(y, MEMBER_ROW));
            y += MEMBER_ROW;
          }
          rects.set(containerId, rect(top, y - top));
        } else {
          rects.set(containerId, rect(y, MEMBER_ROW));
          y += MEMBER_ROW;
        }
      }
      const lastId = state.order[state.order.length - 1];
      if (lastId && state.containers[lastId]?.groupId) {
        rects.set(PENDING_TAIL_DRAG_ID, rect(y, 8));
      }
      return rects;
    }

    function overFor(
      state: ReturnType<typeof buildPendingDragState>,
      activeId: string,
      draggedTop: number
    ) {
      const droppableRects = layoutOf(state);
      const collisions = pendingDragCollisionDetection(state)({
        active: { id: activeId },
        collisionRect: rect(draggedTop, MEMBER_ROW),
        droppableRects,
        droppableContainers: [...droppableRects.keys()].map((id) => ({ id })),
        pointerCoordinates: null,
      } as never);
      return collisions[0] ? String(collisions[0].id) : undefined;
    }

    /**
     * One pass of the panel's drag loop per position: resolve `over` against
     * the layout the preview currently paints, apply it, then re-resolve
     * against the layout that produced — the reflow dnd-kit would re-measure.
     * A position has settled when that second pass agrees, or reports the
     * dragged row itself (which `handleDragOver` ignores precisely because the
     * preview already matches the pointer).
     */
    function walk(
      groups: Array<{
        id: string;
        startIndex: number;
        endIndex: number;
        failFast: boolean;
      }>,
      activeId: string,
      positions: number[]
    ) {
      const committed = buildPendingDragState(walkSteps, 0, groups);
      let preview = committed;
      let overId: string | undefined;
      return positions.map((top) => {
        const next = overFor(preview, activeId, top);
        if (next !== undefined && next !== activeId) {
          overId = next;
          preview = computeLivePreviewState(committed, activeId, overId);
        }
        const settled = overFor(preview, activeId, top);
        return {
          top,
          shape: shapeOf(preview),
          slot: buildPendingReorderPayload(
            preview,
            0,
            groups
          ).newPendingOrder.indexOf(Number(activeId.replace(/\D/g, ""))),
          settled:
            settled === undefined || settled === activeId || settled === overId,
        };
      });
    }

    /** The preview's topology as one comparable string, groups in brackets. */
    function shapeOf(state: ReturnType<typeof buildPendingDragState>) {
      return state.order
        .map((containerId) => {
          const container = state.containers[containerId];
          if (!container) return "?";
          const items = container.items
            .map((id) => id.replace("step-pending-", ""))
            .join(",");
          return container.groupId ? `[${items}]` : items;
        })
        .join(" ");
    }

    // A group pinned to the top of the list can only be entered from below,
    // which is the direction the dragged row's previewed position lands
    // squarely under the pointer — the case that never settled.
    it("gives a leading group's first slot a band of its own, dragged upward", () => {
      const groups = [
        { id: "group-1", startIndex: 0, endIndex: 1, failFast: false },
      ];
      // Header 0-30, members 30-90 and 90-150, ungrouped step 150-210.
      const positions = [140, 120, 100, 80, 60, 40, 20, 0];
      const frames = walk(groups, "step-pending-2", positions);

      expect(frames.filter((frame) => !frame.settled)).toEqual([]);
      // Reached, and held across more than one position rather than flickering
      // through on a single sample.
      expect(
        frames.filter((frame) => frame.shape === "[2,0,1]").length
      ).toBeGreaterThan(1);
      // Monotonic: the step only ever climbs as the pointer does.
      const slots = frames.map((frame) => frame.slot);
      expect(slots.every((slot, i) => i === 0 || slot <= slots[i - 1])).toBe(
        true
      );
    });

    it("gives a trailing group's first slot a band of its own, dragged downward", () => {
      const groups = [
        { id: "group-1", startIndex: 1, endIndex: 2, failFast: false },
      ];
      // Step 0-60, then header 60-90 and members 90-150 and 150-210.
      const positions = [0, 20, 40, 60, 80, 100, 120, 140, 160];
      const frames = walk(groups, "step-pending-0", positions);

      expect(frames.filter((frame) => !frame.settled)).toEqual([]);
      // Above the group, then its first slot, then its second — each held.
      expect(
        frames.filter((frame) => frame.shape === "0 [1,2]").length
      ).toBeGreaterThan(1);
      expect(
        frames.filter((frame) => frame.shape === "[0,1,2]").length
      ).toBeGreaterThan(1);
      expect(
        frames.filter((frame) => frame.shape === "[1,0,2]").length
      ).toBeGreaterThan(1);
      const slots = frames.map((frame) => frame.slot);
      expect(slots.every((slot, i) => i === 0 || slot >= slots[i - 1])).toBe(
        true
      );
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

  it("outlines the whole running group, not the individual member row", () => {
    // The state a run reached when one member of a live group settled first
    // and the boundary was published as the settled count: step 2 is done,
    // step 1 is still going, and `currentStep` sits between them. The panel
    // used to outline whichever step it found at `currentStep`, which is how
    // the row showing a completed check ended up wearing the running outline
    // — and how the group container disappeared on the way. The group is now
    // outlined as a whole instead of per member (see ExecutingStepHighlight),
    // so no member row should carry its own outline.
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

    const groupPanel = screen.getByTestId(`parallel-group-${group.id}`);
    expect(groupPanel).toBeInTheDocument();
    expect(
      within(groupPanel).getByTestId("parallel-group-executing-highlight")
    ).toBeInTheDocument();
    expect(
      within(groupPanel).queryByTestId("executing-step-highlight")
    ).not.toBeInTheDocument();
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

describe("WorkflowStepsPanel drag layout tracing", () => {
  const steps = [
    { prompt: "one" },
    { prompt: "two" },
    { prompt: "three" },
    { prompt: "four" },
  ];
  const groups = [
    { id: "group-1", startIndex: 1, endIndex: 2, failFast: false },
  ];

  it("renders the committed topology with a group's members bracketed", () => {
    expect(describePendingDragState(buildPendingDragState(steps, 0, []))).toBe(
      "0 1 2 3"
    );
    expect(
      describePendingDragState(buildPendingDragState(steps, 0, groups))
    ).toBe("0 [1,2] 3");
  });

  it("describes where a group drag actually lands", () => {
    const next = movePendingDragContainer(
      buildPendingDragState(steps, 0, groups),
      "group-group-1",
      "step-pending-0"
    );
    // The group took the first slot, so the step it passed is now below it.
    expect(describePendingDragState(next)).toBe("[1,2] 0 3");
  });
});

describe("WorkflowStepsPanel sorting strategy", () => {
  // The state above, after the group has been dragged into the first slot:
  // the model is `[group] step step`, and the panel has already re-rendered
  // the list in that order, so index 0 is the group and index 1 is the step
  // it moved past.
  const groupRect = {
    top: 0,
    left: 0,
    right: 100,
    bottom: 300,
    width: 100,
    height: 300,
  };
  const stepRect = {
    top: 300,
    left: 0,
    right: 100,
    bottom: 360,
    width: 100,
    height: 60,
  };
  const args = {
    activeIndex: 0,
    overIndex: 1,
    index: 1,
    rects: [groupRect, stepRect, { ...stepRect, top: 360, bottom: 420 }],
    activeNodeRect: groupRect,
  };

  it("would otherwise paint the step back above the group it sits below", () => {
    // Why the panel cannot use a built-in strategy: it displaces the step by
    // the whole dragged group's height, which is the move the live preview has
    // already made for real. The step is painted at or above the group's top —
    // the opposite order from the one the drop will commit, which is exactly
    // the "preview showed it below, it landed above" report.
    const displaced = verticalListSortingStrategy(args);
    expect(displaced).not.toBeNull();
    expect(stepRect.top + displaced!.y).toBeLessThanOrEqual(groupRect.top);
  });

  it("leaves every sibling where the live preview rendered it", () => {
    expect(livePreviewSortingStrategy(args)).toBeNull();
    expect(livePreviewSortingStrategy({ ...args, index: 2 })).toBeNull();
    // Including the dragged container's own slot — the drag source is
    // displaced by `shouldDisplaceDragSource`, which never consults this.
    expect(livePreviewSortingStrategy({ ...args, index: 0 })).toBeNull();
  });
});

describe("WorkflowStepsPanel group drag settling", () => {
  // The reported layout: two loose steps, a two-member group, then four more
  // loose steps — `0 1 [2,3] 4 5 6 7`.
  const steps = Array.from({ length: 8 }, (_, index) => ({
    prompt: `step ${index}`,
  }));
  const groups = [
    { id: "group-1", startIndex: 2, endIndex: 3, failFast: false },
  ];
  const state = buildPendingDragState(steps, 0, groups);
  const HOME = "0 1 [2,3] 4 5 6 7";
  /** The group starts at this offset; a drag begins with translate 0. */
  const HOME_TOP = 120;

  const ROW = 60;
  const HEADER = 30;
  const GROUP = HEADER + ROW * 2;

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

  /** Lay the previewed containers out top to bottom, the way the panel does. */
  function layout(preview: ReturnType<typeof buildPendingDragState>) {
    const measured = new Map<string, ReturnType<typeof rect>>();
    let y = 0;
    for (const containerId of preview.order) {
      const container = preview.containers[containerId];
      if (!container) continue;
      if (container.groupId) {
        measured.set(
          containerId,
          rect(y, HEADER + ROW * container.items.length)
        );
        y += HEADER;
        for (const item of container.items) {
          measured.set(item, rect(y, ROW));
          y += ROW;
        }
        continue;
      }
      measured.set(containerId, rect(y, ROW));
      y += ROW;
    }
    return measured;
  }

  /**
   * Walk the dragged group down the list one small step at a time, running the
   * panel's real feedback loop: collisions are resolved against the *previewed*
   * layout (which the preview physically re-renders, so everything is
   * re-measured every time it changes), and `handleDragOver`'s rule that
   * `over === activeId` means "the preview already matches the pointer" keeps
   * the previous target rather than applying a self-drop.
   *
   * `collisionRect` is the group's rect as dnd-kit reports it — the position it
   * had at drag start plus the pointer translate, which is the one quantity in
   * a drag that moves only on real input.
   */
  function walk(tops: number[]) {
    let over: string | null = null;
    return tops.map((top) => {
      const preview =
        over === null
          ? state
          : computeLivePreviewState(state, "group-group-1", over);
      const measured = layout(preview);
      const collisions = pendingDragCollisionDetection(preview)({
        active: { id: "group-group-1" },
        collisionRect: rect(top, GROUP),
        droppableRects: measured,
        droppableContainers: [...measured.keys()].map((id) => ({ id })),
        pointerCoordinates: null,
      } as never);
      const first = collisions[0] ? String(collisions[0].id) : undefined;
      if (first !== undefined && first !== "group-group-1") {
        over = first;
      }
      return describePendingDragState(
        over === null
          ? state
          : computeLivePreviewState(state, "group-group-1", over)
      );
    });
  }

  /** Drag positions from where the group starts (translate 0) downward. */
  const DOWNWARD = Array.from(
    { length: 35 },
    (_, index) => HOME_TOP + index * 10
  );

  it("gives the group's own slot a band instead of a knife-edge", () => {
    // Without its own rect among the candidates the only targets are the rows
    // either side, and at the home position those are equidistant by
    // construction — so one pixel of movement flipped the group from above the
    // previous row to below the next one, and the slot it actually occupies
    // was never previewed at all. The trace from the report showed exactly two
    // layouts alternating for a whole drag, with the committed one absent from
    // every line.
    expect(
      walk([HOME_TOP, HOME_TOP + 20, HOME_TOP + 40, HOME_TOP + 50])
    ).toEqual([HOME, HOME, HOME, HOME]);
  });

  it("advances one slot at a time, never two", () => {
    const slots = walk(DOWNWARD).map((layout) =>
      layout.split(" ").findIndex((entry) => entry.startsWith("["))
    );
    for (const [index, slot] of slots.entries()) {
      if (index === 0) continue;
      expect(slot - slots[index - 1]).toBeGreaterThanOrEqual(0);
      expect(slot - slots[index - 1]).toBeLessThanOrEqual(1);
    }
    // And it really travels, or the assertion above is vacuous.
    expect(slots[0]).toBe(2);
    expect(slots[slots.length - 1]).toBe(6);
  });

  it("lets every slot it passes through hold still", () => {
    // The report could only land between two rows by dragging "very very
    // slowly". Every layout the walk produces must survive several
    // consecutive positions, so none of them is a knife-edge.
    const layouts = walk(DOWNWARD);
    const runs = layouts.reduce<Array<{ layout: string; length: number }>>(
      (accumulated, layout) => {
        const last = accumulated[accumulated.length - 1];
        if (last?.layout === layout) last.length += 1;
        else accumulated.push({ layout, length: 1 });
        return accumulated;
      },
      []
    );
    for (const run of runs) {
      expect(run.length).toBeGreaterThan(1);
    }
    expect(runs.map((run) => run.layout)).toEqual([
      HOME,
      "0 1 4 [2,3] 5 6 7",
      "0 1 4 5 [2,3] 6 7",
      "0 1 4 5 6 [2,3] 7",
      "0 1 4 5 6 7 [2,3]",
    ]);
  });
});
