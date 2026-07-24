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
import { ExecutingStepHighlight } from "@components/prompts/ExecutingStepHighlight";
import { useEditorStore } from "@store/editorStore";
import { useSettingsStore } from "@store/settingsStore";
import { useUiStore } from "@store/uiStore";
import { useWorkflowStore } from "@store/workflowStore";
import { FINAL_STEP_PHASES, MESSAGE_TYPES } from "@/types/messages";
import { EXECUTION_STATES, STEP_STATUS } from "@/types/messages";

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
      steps: [
        { prompt: "Step 1" },
        { prompt: "Step 2" },
        { prompt: "Step 3" },
      ],
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
