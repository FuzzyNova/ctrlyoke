import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
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
      "transition-[transform,height,opacity]"
    );
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
      "transition-[transform,height,opacity]"
    );
    expect(highlight).not.toHaveClass("border-2");
    expect(
      document.querySelector('[data-workflow-chip-index="1"]')
    ).toBeInTheDocument();
  });

  it("remeasures the execution highlight when the target mounts at zero height", async () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    let targetHeight = 0;
    let targetTop = 0;
    const requestAnimationFrameSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback: FrameRequestCallback) => {
        frameCallbacks.push(callback);
        return frameCallbacks.length;
      });
    const cancelAnimationFrameSpy = vi
      .spyOn(window, "cancelAnimationFrame")
      .mockImplementation(() => {});
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        if (this.dataset.highlightTarget === "true") {
          return {
            x: 0,
            y: targetTop,
            top: targetTop,
            left: 0,
            right: 100,
            bottom: targetTop + targetHeight,
            width: 100,
            height: targetHeight,
            toJSON: () => {},
          };
        }

        return {
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          right: 100,
          bottom: 200,
          width: 100,
          height: 200,
          toJSON: () => {},
        };
      });

    const container = document.createElement("div");
    const renderRoot = document.createElement("div");
    const target = document.createElement("div");
    target.dataset.highlightTarget = "true";
    container.append(renderRoot, target);
    document.body.appendChild(container);
    const containerRef = { current: container };

    try {
      render(
        <ExecutingStepHighlight
          containerRef={containerRef}
          layoutKey="running"
          targetSelector="[data-highlight-target='true']"
          visible
        />,
        { container: renderRoot }
      );
      const highlight = screen.getByTestId("executing-step-highlight");
      expect(highlight).toHaveStyle({ height: "0px" });

      targetTop = 48;
      targetHeight = 32;
      await waitFor(() => expect(frameCallbacks.length).toBeGreaterThan(0));
      act(() => {
        while (frameCallbacks.length > 0) {
          frameCallbacks.shift()?.(0);
        }
      });

      expect(highlight).toHaveStyle({
        height: "32px",
        transform: "translateY(48px)",
      });
    } finally {
      container.remove();
      rectSpy.mockRestore();
      requestAnimationFrameSpy.mockRestore();
      cancelAnimationFrameSpy.mockRestore();
    }
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
});
