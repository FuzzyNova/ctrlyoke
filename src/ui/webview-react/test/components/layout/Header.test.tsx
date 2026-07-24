import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Header } from "@components/layout/Header";
import { useUiStore } from "@store/uiStore";
import { useWorkflowStore } from "@store/workflowStore";
import { EXECUTION_STATES, MESSAGE_TYPES } from "@/types/messages";

const postMessage = vi.fn();
const runRef = "run-2026-07-20T10-30-00-000Z" as never;

describe("Header execution controls", () => {
  beforeEach(() => {
    useWorkflowStore.getState().resetWorkflow();
    useUiStore.getState().resetUi();
    postMessage.mockReset();
    Object.defineProperty(window, "vscodeApi", {
      configurable: true,
      value: { postMessage, getState: vi.fn(), setState: vi.fn() },
    });
    useWorkflowStore.getState().loadWorkflow({
      fileName: "workflow.ctrlyoke.json",
      workflowName: "Run view",
      steps: [{ prompt: "first" }, { prompt: "second" }],
      executionState: EXECUTION_STATES.IDLE,
    });
    useUiStore.setState({
      displayedViewAddress: {
        workflowKey: "workflow-a" as never,
        kind: "run",
        runRef,
      },
      displayedDefinitionRevision: 3,
      displayedDescriptorRevision: 7,
      pendingRewind: { fromStepIndex: 1, baseDefinitionRevision: 2 },
      runSummaries: [
        {
          workflowKey: "workflow-a" as never,
          runRef,
          runId: 4,
          startedAt: 1,
          executionState: EXECUTION_STATES.IDLE,
          stepCount: 2,
          definitionRevision: 3,
          hasMixedHarnesses: false,
          hasMixedModels: false,
        },
      ],
    });
  });

  afterEach(cleanup);

  it("keeps exactly three execution slots and places discard actions in the continuation banner", () => {
    render(<Header />);

    const controls = screen.getByRole("group", {
      name: "Workflow execution controls",
    });
    expect(controls.querySelectorAll("button")).toHaveLength(3);
    expect(screen.getByText("Continuing run from step 2")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Discard Continuation" })
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.CONTINUE_RUN,
      address: {
        workflowKey: "workflow-a",
        kind: "run",
        runRef,
      },
      expectedDefinitionRevision: 3,
      expectedDescriptorRevision: 7,
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Start new run instead" })
    );
    expect(postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.START_NEW_RUN_INSTEAD,
      address: {
        workflowKey: "workflow-a",
        kind: "run",
        runRef,
      },
      expectedDefinitionRevision: 3,
      expectedDescriptorRevision: 7,
    });
  });

  it("renders the suffix-edit confirmation as our own modal (never a native dialog) and confirms via postMessage", () => {
    useUiStore.setState({
      suffixEditConfirmation: {
        action: "discardContinuation",
        address: { workflowKey: "workflow-a" as never, kind: "run", runRef },
        expectedDefinitionRevision: 3,
        expectedDescriptorRevision: 7,
      },
    });

    render(<Header />);

    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByText(
        "Discard continuation edits? Your changes to the rewound suffix will be lost."
      )
    ).toBeInTheDocument();

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Discard Continuation" })
    );

    expect(postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.DISCARD_CONTINUATION,
      address: { workflowKey: "workflow-a", kind: "run", runRef },
      expectedDefinitionRevision: 3,
      expectedDescriptorRevision: 7,
      confirmEditedSuffix: true,
    });
    expect(useUiStore.getState().suffixEditConfirmation).toBeNull();
  });

  it("clears the suffix-edit confirmation on cancel without posting a message", () => {
    useUiStore.setState({
      suffixEditConfirmation: {
        action: "startNewRunInstead",
        address: { workflowKey: "workflow-a" as never, kind: "run", runRef },
        expectedDefinitionRevision: 3,
        expectedDescriptorRevision: 7,
      },
    });

    render(<Header />);

    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByRole("button", { name: "Start New Run" })
    ).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ confirmEditedSuffix: true })
    );
    expect(useUiStore.getState().suffixEditConfirmation).toBeNull();
  });

  it("shows Run, Pause, and Stop for a newly loaded draft", () => {
    useUiStore.setState({
      displayedViewAddress: {
        workflowKey: "workflow-b" as never,
        kind: "draft",
      },
      executionRunRef: null,
      pendingRewind: null,
      runSummaries: [],
    });

    render(<Header />);

    expect(screen.getByRole("button", { name: "Run" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Pause" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Stop" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.EXECUTE_DRAFT,
      address: { workflowKey: "workflow-b", kind: "draft" },
      expectedDefinitionRevision: 3,
      expectedDescriptorRevision: 7,
    });
  });

  // The primary Run affordance must remain discoverable even when an empty new
  // workflow cannot run yet. Secondary inactive slots can still collapse below
  // xs; assert the responsive classes because jsdom does not apply breakpoints.
  it("keeps disabled Run visible while collapsing inactive secondary slots below xs", () => {
    useUiStore.setState({
      displayedViewAddress: {
        workflowKey: "workflow-b" as never,
        kind: "draft",
      },
      executionRunRef: null,
      pendingRewind: null,
      runSummaries: [],
    });
    useWorkflowStore.getState().loadWorkflow({
      fileName: "new-workflow.ctrlyoke.json",
      workflowName: "New workflow",
      steps: [],
      executionState: EXECUTION_STATES.IDLE,
    });

    render(<Header />);

    const controls = screen.getByRole("group", {
      name: "Workflow execution controls",
    });

    const runButton = screen.getByRole("button", { name: "Run" });
    expect(runButton).toBeDisabled();
    expect(runButton.className).toContain("flex bg-btn-secondary-bg");
    expect(runButton.className).not.toContain("hidden");
    for (const label of ["Pause", "Stop"]) {
      expect(screen.getByRole("button", { name: label }).className).toContain(
        "hidden xs:flex"
      );
    }
    // Neither divider separates two visible slots here.
    const dividers = controls.querySelectorAll(".fp-button-group-divider");
    expect(dividers).toHaveLength(2);
    for (const divider of dividers) {
      expect(divider.className).toContain("hidden xs:block");
    }
  });

  it("offers Re-run immediately when navigation addresses a completed run", () => {
    useUiStore.setState({
      displayedViewAddress: {
        workflowKey: "completed-workflow" as never,
        kind: "run",
        runRef,
      },
      executionRunRef: null,
      pendingRewind: null,
      runSummaries: [],
    });
    // WorkflowStatus updates the addressed view optimistically before the
    // asynchronous RUN_VIEW_LOADED definition snapshot arrives.
    useWorkflowStore.getState().resetWorkflow();
    useWorkflowStore.getState().setExecutionState(EXECUTION_STATES.COMPLETED);

    render(<Header />);

    const rerunButton = screen.getByRole("button", { name: "Re-run" });
    expect(rerunButton).toBeEnabled();
    expect(rerunButton.className).toContain("flex bg-btn-bg");
    for (const label of ["Pause", "Stop"]) {
      expect(screen.getByRole("button", { name: label }).className).toContain(
        "hidden xs:flex"
      );
    }
  });

  it("shows only Re-run below xs for a stopped run", () => {
    useUiStore.setState({
      displayedViewAddress: {
        workflowKey: "workflow-a" as never,
        kind: "run",
        runRef,
      },
      executionRunRef: null,
      pendingRewind: null,
      runSummaries: [],
    });
    useWorkflowStore.getState().setExecutionState(EXECUTION_STATES.STOPPED);

    render(<Header />);

    expect(screen.getByRole("button", { name: "Re-run" }).className).toContain(
      "flex bg-btn-bg"
    );
    const resumeButton = screen.getByRole("button", { name: "Resume" });
    expect(resumeButton).toBeEnabled();
    expect(resumeButton.className).toContain("hidden xs:flex");
    expect(screen.getByRole("button", { name: "Stop" }).className).toContain(
      "hidden xs:flex"
    );
  });

  it("keeps a divider visible when both of the slots it separates are", () => {
    useUiStore.setState({
      displayedViewAddress: {
        workflowKey: "workflow-a" as never,
        kind: "run",
        runRef,
      },
      executionRunRef: runRef,
      pendingRewind: null,
      runSummaries: [
        {
          workflowKey: "workflow-a" as never,
          runRef,
          runId: 4,
          startedAt: 1,
          executionState: EXECUTION_STATES.RUNNING,
          stepCount: 2,
          definitionRevision: 3,
          hasMixedHarnesses: false,
          hasMixedModels: false,
        },
      ],
    });
    useWorkflowStore.getState().setExecutionState(EXECUTION_STATES.RUNNING);

    render(<Header />);

    // Pause and Stop are both live while running, so the divider between them
    // must not be hidden.
    expect(screen.getByRole("button", { name: "Pause" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Re-run" }).className).toContain(
      "hidden xs:flex"
    );
    const dividers = screen
      .getByRole("group", { name: "Workflow execution controls" })
      .querySelectorAll(".fp-button-group-divider");
    expect(dividers[1].className).not.toContain("hidden");
  });

  it("switches from active controls to Re-run as soon as execution completes", () => {
    useUiStore.setState({
      displayedViewAddress: {
        workflowKey: "workflow-a" as never,
        kind: "run",
        runRef,
      },
      executionRunRef: runRef,
      pendingRewind: null,
      runSummaries: [
        {
          workflowKey: "workflow-a" as never,
          runRef,
          runId: 4,
          startedAt: 1,
          executionState: EXECUTION_STATES.RUNNING,
          stepCount: 2,
          definitionRevision: 3,
          hasMixedHarnesses: false,
          hasMixedModels: false,
        },
      ],
    });
    useWorkflowStore.getState().setExecutionState(EXECUTION_STATES.RUNNING);
    render(<Header />);

    expect(screen.getByRole("button", { name: "Pause" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();

    act(() => {
      useWorkflowStore.getState().setExecutionState(EXECUTION_STATES.COMPLETED);
      useUiStore
        .getState()
        .markExecutionRunFinished(EXECUTION_STATES.COMPLETED);
    });

    expect(screen.getByRole("button", { name: "Re-run" })).toBeEnabled();
    for (const label of ["Pause", "Stop"]) {
      expect(screen.getByRole("button", { name: label }).className).toContain(
        "hidden xs:flex"
      );
    }
  });

  it("targets the active workflow run when an append continuation has not refreshed executionRunRef yet", () => {
    useUiStore.setState({
      activeWorkflowId: "workflow-instance",
      executionRunRef: null,
      pendingRewind: null,
      loadedWorkflows: [
        {
          id: "workflow-instance",
          workflowKey: "workflow-a" as never,
          runRef,
          workflowName: "Run view",
          filePath: "workflow.ctrlyoke.json",
          executionState: EXECUTION_STATES.RUNNING,
          currentStep: 1,
          totalSteps: 2,
        },
      ],
    });
    useWorkflowStore.getState().setExecutionState(EXECUTION_STATES.RUNNING);

    render(<Header />);

    const executionControls = screen.getByRole("group", {
      name: "Workflow execution controls",
    });
    fireEvent.click(
      within(executionControls).getByRole("button", { name: "Stop" })
    );
    expect(postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.STOP_RUN,
      address: {
        workflowKey: "workflow-a",
        kind: "run",
        runRef,
      },
    });
  });
});
