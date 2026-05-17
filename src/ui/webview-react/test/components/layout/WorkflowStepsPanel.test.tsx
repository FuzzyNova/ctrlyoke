import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowStepsPanel } from "@components/layout/WorkflowStepsPanel";
import { useEditorStore } from "@store/editorStore";
import { useSettingsStore } from "@store/settingsStore";
import { useUiStore } from "@store/uiStore";
import { useWorkflowStore } from "@store/workflowStore";
import { FINAL_STEP_PHASES, MESSAGE_TYPES } from "@/types/messages";

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
});
