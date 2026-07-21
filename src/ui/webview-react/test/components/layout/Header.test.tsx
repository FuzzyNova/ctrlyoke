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

  it("shows Run, Resume, and Stop for a newly loaded draft", () => {
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
    expect(screen.getByRole("button", { name: "Resume" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Stop" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.EXECUTE_DRAFT,
      address: { workflowKey: "workflow-b", kind: "draft" },
      expectedDefinitionRevision: 3,
      expectedDescriptorRevision: 7,
    });
  });
});
