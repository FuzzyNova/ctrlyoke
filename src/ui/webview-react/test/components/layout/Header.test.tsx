import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

  // Below xs there is no room for greyed-out affordances, so a disabled slot is
  // hidden rather than dimmed. The slots stay in the DOM (they are only display-
  // toggled by breakpoint), so assert the classes rather than presence.
  it("hides disabled execution slots and their orphaned dividers below xs", () => {
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

    const controls = screen.getByRole("group", {
      name: "Workflow execution controls",
    });
    // Run is enabled for a draft — visible at every width.
    expect(screen.getByRole("button", { name: "Run" }).className).toContain(
      "flex bg-btn-bg"
    );
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
    const dividers = screen
      .getByRole("group", { name: "Workflow execution controls" })
      .querySelectorAll(".fp-button-group-divider");
    expect(dividers[1].className).not.toContain("hidden");
  });
});
