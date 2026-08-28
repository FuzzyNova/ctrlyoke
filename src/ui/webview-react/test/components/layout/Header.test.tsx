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
import { useExecutionPreviewStore } from "@store/executionPreviewStore";
import { EXECUTION_STATES, MESSAGE_TYPES, RUNNER_IDS } from "@/types/messages";
import { WORKFLOW_VIEW_ADDRESS_KIND } from "@root/types/DashboardConstants";

const postMessage = vi.fn();
const runRef = "run-2026-07-20T10-30-00-000Z" as never;

describe("Header execution controls", () => {
  beforeEach(() => {
    useWorkflowStore.getState().resetWorkflow();
    useUiStore.getState().resetUi();
    useExecutionPreviewStore.getState().reset();
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
        kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
        runRef,
      },
      displayedDefinitionRevision: 3,
      displayedDescriptorRevision: 7,
      pendingRewind: { fromStepIndex: 1, baseDefinitionRevision: 2 },
      runSummaries: [
        {
          workflowKey: "workflow-a" as never,
          runRef,
          runDirectory: "/runs/workflow-a/run",
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

  it("opens the workflow-scoped Dry Run from the action controls", () => {
    render(<Header />);

    const actionGroup = screen.getByRole("group", {
      name: "Workflow action controls",
    });
    const labels = Array.from(actionGroup.querySelectorAll("button")).map(
      (button) => button.getAttribute("aria-label")
    );
    expect(labels.indexOf("Dry Run")).toBeGreaterThan(
      labels.indexOf("Save workflow")
    );
    expect(labels.indexOf("Dry Run")).toBeLessThan(labels.indexOf("Undo"));

    fireEvent.click(
      within(actionGroup).getByRole("button", { name: "Dry Run" })
    );

    expect(useExecutionPreviewStore.getState().scope).toEqual({
      kind: "workflow",
    });
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MESSAGE_TYPES.REQUEST_EXECUTION_PREVIEW,
        scope: { kind: "workflow" },
      })
    );
  });

  it("shows Restart/Continue/Stop and places discard in the continuation banner", () => {
    render(<Header />);

    const controls = screen.getByRole("group", {
      name: "Workflow execution controls",
    });
    expect(controls.querySelectorAll("button")).toHaveLength(3);
    expect(screen.getByText("Continuing run from step 2")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Discard Continuation" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Start new run instead" })
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.CONTINUE_RUN,
      address: {
        workflowKey: "workflow-a",
        kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
        runRef,
      },
      expectedDefinitionRevision: 3,
      expectedDescriptorRevision: 7,
    });

    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    expect(postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.START_NEW_RUN_INSTEAD,
      address: {
        workflowKey: "workflow-a",
        kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
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
        address: {
          workflowKey: "workflow-a" as never,
          kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
          runRef,
        },
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
      address: {
        workflowKey: "workflow-a",
        kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
        runRef,
      },
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
        address: {
          workflowKey: "workflow-a" as never,
          kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
          runRef,
        },
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
        kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
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
      address: {
        workflowKey: "workflow-b",
        kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
      },
      expectedDefinitionRevision: 3,
      expectedDescriptorRevision: 7,
    });
  });

  it("runs a final-step-only draft", () => {
    useUiStore.setState({
      displayedViewAddress: {
        workflowKey: "workflow-b" as never,
        kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
      },
      executionRunRef: null,
      pendingRewind: null,
      runSummaries: [],
    });
    useWorkflowStore.getState().loadWorkflow({
      fileName: "final-step-only.ctrlyoke.json",
      workflowName: "Final step only",
      steps: [],
      finalStep: { prompt: "Generate the workflow steps" },
      executionState: EXECUTION_STATES.IDLE,
    });

    render(<Header />);

    const runButton = screen.getByRole("button", { name: "Run" });
    expect(runButton).toBeEnabled();
    for (const saveButton of screen.getAllByRole("button", {
      name: "Save workflow",
    })) {
      expect(saveButton).toBeEnabled();
    }

    fireEvent.click(runButton);
    expect(postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.EXECUTE_DRAFT,
      address: {
        workflowKey: "workflow-b",
        kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
      },
      expectedDefinitionRevision: 3,
      expectedDescriptorRevision: 7,
    });
  });

  // The primary Run affordance must remain discoverable even when an empty new
  // workflow cannot run yet. Saving an empty workflow is valid; secondary
  // inactive execution slots can still collapse below xs. Assert the responsive
  // classes because jsdom does not apply breakpoints.
  it("keeps disabled Run visible but saves an empty draft", () => {
    useUiStore.setState({
      displayedViewAddress: {
        workflowKey: "workflow-b" as never,
        kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
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
    const [saveButton] = screen.getAllByRole("button", {
      name: "Save workflow",
    });
    expect(saveButton).toBeEnabled();
    fireEvent.click(saveButton);
    expect(postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.SAVE_WORKFLOW_REQUEST,
      requestId: expect.stringMatching(/^save-/),
      address: {
        workflowKey: "workflow-b",
        kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
      },
    });
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
        kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
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

  // `Set start position` on the first step seeds a run without executing it, so
  // a run can sit here having run nothing. Re-run would fork yet another empty
  // run; Run executes the one on screen via the same continuation path.
  it("offers Run for a seeded run that has never executed a step", () => {
    useUiStore.setState({
      displayedViewAddress: {
        workflowKey: "workflow-a" as never,
        kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
        runRef,
      },
      executionRunRef: null,
      pendingRewind: null,
      runSummaries: [],
    });
    useWorkflowStore.getState().loadWorkflow({
      fileName: "workflow.ctrlyoke.json",
      workflowName: "Seeded run",
      steps: [{ prompt: "first" }, { prompt: "second" }],
      executionState: EXECUTION_STATES.IDLE,
      currentStep: 0,
    });

    render(<Header />);

    expect(
      screen.queryByRole("button", { name: "Re-run" })
    ).not.toBeInTheDocument();
    const runButton = screen.getByRole("button", { name: "Run" });
    expect(runButton).toBeEnabled();

    fireEvent.click(runButton);
    expect(postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.CONTINUE_RUN,
      address: {
        workflowKey: "workflow-a",
        kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
        runRef,
      },
      expectedDefinitionRevision: 3,
      expectedDescriptorRevision: 7,
    });
  });

  it("keeps Re-run for an idle run whose steps already have runtime", () => {
    useUiStore.setState({
      displayedViewAddress: {
        workflowKey: "workflow-a" as never,
        kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
        runRef,
      },
      executionRunRef: null,
      pendingRewind: null,
      runSummaries: [],
    });
    useWorkflowStore.getState().loadWorkflow({
      fileName: "workflow.ctrlyoke.json",
      workflowName: "Partially executed run",
      steps: [
        { prompt: "first", _runtime: { startedAt: 1, completedAt: 2 } },
        { prompt: "second" },
      ],
      executionState: EXECUTION_STATES.IDLE,
      currentStep: 0,
    });

    render(<Header />);

    expect(screen.getByRole("button", { name: "Re-run" })).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: "Run" })
    ).not.toBeInTheDocument();
  });

  it("shows only Re-run below xs for a stopped run", () => {
    useUiStore.setState({
      displayedViewAddress: {
        workflowKey: "workflow-a" as never,
        kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
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
        kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
        runRef,
      },
      executionRunRef: runRef,
      pendingRewind: null,
      runSummaries: [
        {
          workflowKey: "workflow-a" as never,
          runRef,
          runDirectory: "/runs/workflow-a/run",
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
        kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
        runRef,
      },
      executionRunRef: runRef,
      pendingRewind: null,
      runSummaries: [
        {
          workflowKey: "workflow-a" as never,
          runRef,
          runDirectory: "/runs/workflow-a/run",
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

  // `runSummaries` is frozen at the last RUN_VIEW_LOADED. A run seeded and
  // started in one gesture leaves that snapshot reading "idle" for its whole
  // lifetime, which used to win over the live state — hiding the pausing banner
  // and leaving slot 2 on a disabled Pause with no way to resume.
  const stalelyLoadedPausingRun = (
    executionState:
      | typeof EXECUTION_STATES.PAUSING
      | typeof EXECUTION_STATES.PAUSED
  ) => {
    useUiStore.setState({
      activeWorkflowId: "workflow-instance",
      displayedViewAddress: {
        workflowKey: "workflow-a" as never,
        kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
        runRef,
      },
      executionRunRef: runRef,
      pendingRewind: null,
      runSummaries: [
        {
          workflowKey: "workflow-a" as never,
          runRef,
          runDirectory: "/runs/workflow-a/run",
          runId: 4,
          startedAt: 1,
          executionState: EXECUTION_STATES.IDLE,
          stepCount: 2,
          definitionRevision: 3,
          hasMixedHarnesses: false,
          hasMixedModels: false,
        },
      ],
      loadedWorkflows: [
        {
          id: "workflow-instance",
          workflowKey: "workflow-a" as never,
          runRef,
          workflowName: "Run view",
          filePath: "workflow.ctrlyoke.json",
          executionState,
          currentStep: 1,
          totalSteps: 2,
        },
      ],
    });
    useWorkflowStore.getState().setExecutionState(executionState);
  };

  it("shows the pausing banner and Cancel pause while the run snapshot is stale", () => {
    stalelyLoadedPausingRun(EXECUTION_STATES.PAUSING);

    render(<Header />);

    expect(
      screen.getByText("Workflow will pause after the current step completes")
    ).toBeInTheDocument();
    const executionControls = screen.getByRole("group", {
      name: "Workflow execution controls",
    });
    expect(
      within(executionControls).getByRole("button", { name: "Cancel pause" })
    ).toBeEnabled();
    expect(
      within(executionControls).getByRole("button", { name: "Stop" })
    ).toBeEnabled();
  });

  it("offers Resume for a paused run whose snapshot still reads idle", () => {
    stalelyLoadedPausingRun(EXECUTION_STATES.PAUSED);

    render(<Header />);

    expect(
      screen.queryByText("Workflow will pause after the current step completes")
    ).not.toBeInTheDocument();
    const executionControls = screen.getByRole("group", {
      name: "Workflow execution controls",
    });
    const resumeButton = within(executionControls).getByRole("button", {
      name: "Resume",
    });
    expect(resumeButton).toBeEnabled();
    expect(
      within(executionControls).getByRole("button", { name: "Stop" })
    ).toBeEnabled();

    fireEvent.click(resumeButton);
    expect(postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.RESUME_RUN,
      address: {
        workflowKey: "workflow-a",
        kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
        runRef,
      },
    });
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
        kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
        runRef,
      },
    });
  });

  it("locks down sibling-owned runs and sends the sibling stop request", () => {
    useUiStore.setState({
      activeWorkflowId: "sibling-instance",
      executionRunRef: runRef,
      pendingRewind: null,
      loadedWorkflows: [
        {
          id: "sibling-instance",
          workflowKey: "workflow-a" as never,
          runRef,
          workflowName: "Sibling workflow",
          filePath: "workflow.ctrlyoke.json",
          executionState: EXECUTION_STATES.RUNNING,
          currentStep: 1,
          totalSteps: 2,
          externalOwner: {
            locality: "external",
            runner: RUNNER_IDS.VSCODE,
          },
        },
      ],
    });
    useWorkflowStore.getState().setExecutionState(EXECUTION_STATES.RUNNING);

    render(<Header />);

    const controls = screen.getByRole("group", {
      name: "Workflow execution controls",
    });
    expect(
      within(controls).getByRole("button", { name: "Re-run" })
    ).toBeDisabled();
    expect(
      within(controls).getByRole("button", { name: "Stop" })
    ).toHaveAttribute("title", "Stop run in another ctrlyoke window");

    fireEvent.click(within(controls).getByRole("button", { name: "Stop" }));
    expect(postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.STOP_VSCODE_RUN,
      workflowId: "sibling-instance",
    });
  });

  it("locks down CLI-owned runs and sends the CLI stop request", () => {
    useUiStore.setState({
      activeWorkflowId: "cli-instance",
      executionRunRef: runRef,
      pendingRewind: null,
      loadedWorkflows: [
        {
          id: "cli-instance",
          workflowKey: "workflow-a" as never,
          runRef,
          workflowName: "CLI workflow",
          filePath: "workflow.ctrlyoke.json",
          executionState: EXECUTION_STATES.RUNNING,
          currentStep: 1,
          totalSteps: 2,
          externalOwner: { locality: "external", runner: RUNNER_IDS.CLI },
        },
      ],
    });
    useWorkflowStore.getState().setExecutionState(EXECUTION_STATES.RUNNING);

    render(<Header />);

    const controls = screen.getByRole("group", {
      name: "Workflow execution controls",
    });
    expect(
      within(controls).getByRole("button", { name: "Re-run" })
    ).toBeDisabled();
    expect(
      within(controls).getByRole("button", { name: "Stop" })
    ).toHaveAttribute("title", "Stop CLI run");

    fireEvent.click(within(controls).getByRole("button", { name: "Stop" }));
    expect(postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.STOP_CLI_RUN,
      workflowId: "cli-instance",
    });
  });

  it("keeps a local workflow local when an unrelated runner field is present", () => {
    useUiStore.setState({
      activeWorkflowId: "local-instance",
      executionRunRef: runRef,
      pendingRewind: null,
      loadedWorkflows: [
        {
          id: "local-instance",
          workflowKey: "workflow-a" as never,
          runRef,
          workflowName: "Local workflow",
          filePath: "workflow.ctrlyoke.json",
          executionState: EXECUTION_STATES.RUNNING,
          currentStep: 1,
          totalSteps: 2,
          runner: RUNNER_IDS.VSCODE,
        } as never,
      ],
    });
    useWorkflowStore.getState().setExecutionState(EXECUTION_STATES.RUNNING);

    render(<Header />);

    const controls = screen.getByRole("group", {
      name: "Workflow execution controls",
    });
    expect(
      within(controls).getByRole("button", { name: "Stop" })
    ).toHaveAttribute("title", "Stop for run 4");

    fireEvent.click(within(controls).getByRole("button", { name: "Stop" }));
    expect(postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.STOP_RUN,
      address: {
        workflowKey: "workflow-a",
        kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
        runRef,
      },
    });
    expect(postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: MESSAGE_TYPES.STOP_VSCODE_RUN })
    );
  });
});

describe("Header deleted-workflow banner", () => {
  beforeEach(() => {
    useWorkflowStore.getState().resetWorkflow();
    useUiStore.getState().resetUi();
    useExecutionPreviewStore.getState().reset();
    postMessage.mockReset();
    Object.defineProperty(window, "vscodeApi", {
      configurable: true,
      value: { postMessage, getState: vi.fn(), setState: vi.fn() },
    });
    useWorkflowStore.getState().loadWorkflow({
      fileName: "workflow.ctrlyoke.json",
      workflowName: "Deleted One",
      steps: [{ prompt: "first" }],
      executionState: EXECUTION_STATES.IDLE,
    });
    useUiStore.setState({
      displayedViewAddress: {
        workflowKey: "workflow-a" as never,
        kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
      },
      viewingDeletedWorkflow: {
        workflowKey: "workflow-a" as never,
        workflowName: "Deleted One",
      },
    });
  });

  afterEach(cleanup);

  it("shows the banner and locks Save/Dry Run/run controls, but Close still works", () => {
    render(<Header />);

    expect(
      screen.getByText('"Deleted One" has been deleted')
    ).toBeInTheDocument();
    const actionGroup = screen.getByRole("group", {
      name: "Workflow action controls",
    });
    expect(
      within(actionGroup).getByRole("button", { name: "Save workflow" })
    ).toBeDisabled();
    expect(
      within(actionGroup).getByRole("button", { name: "Dry Run" })
    ).toBeDisabled();
    const executionControls = screen.getByRole("group", {
      name: "Workflow execution controls",
    });
    expect(
      within(executionControls).getByRole("button", { name: "Run" })
    ).toBeDisabled();

    fireEvent.click(
      screen.getByRole("button", { name: "Close deleted workflow" })
    );
    expect(postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.CLEAR_WORKFLOW,
    });
  });

  it("does not show the banner once the view navigates to a different workflow", () => {
    useUiStore.setState({
      displayedViewAddress: {
        workflowKey: "workflow-b" as never,
        kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
      },
    });

    render(<Header />);

    expect(
      screen.queryByText('"Deleted One" has been deleted')
    ).not.toBeInTheDocument();
    const actionGroup = screen.getByRole("group", {
      name: "Workflow action controls",
    });
    expect(
      within(actionGroup).getByRole("button", { name: "Dry Run" })
    ).toBeEnabled();
  });
});
