/**
 * Tests for WorkflowStatus.
 *
 * WorkflowStatus depends on workflowStore, uiStore, settingsStore and vscodeApi.
 * Strategy: preset store state, render, assert what's visible and what's posted.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkflowStatus } from "@components/workflow/WorkflowStatus";
import { useWorkflowStore } from "@store/workflowStore";
import { useUiStore } from "@store/uiStore";
import { useSettingsStore } from "@store/settingsStore";
import { MESSAGE_TYPES, EXECUTION_STATES } from "@/types/messages";

const postMessageSpy = vi.fn();

beforeEach(() => {
  useWorkflowStore.getState().resetWorkflow();
  useWorkflowStore.temporal.getState().clear();
  useUiStore.getState().resetUi();
  useSettingsStore.getState().resetSettings();
  (
    window.vscodeApi as unknown as { postMessage: ReturnType<typeof vi.fn> }
  ).postMessage = postMessageSpy;
  postMessageSpy.mockClear();
});

describe("WorkflowStatus — empty state", () => {
  it("shows 'No workflow loaded' when fileName is null", () => {
    render(<WorkflowStatus />);
    expect(screen.getByText(/No workflow loaded/i)).toBeInTheDocument();
  });
});

describe("WorkflowStatus — loaded state", () => {
  beforeEach(() => {
    useWorkflowStore.setState({
      fileName: "/workspace/my-workflow.flightpath.yaml",
      workflowName: "My Workflow",
    });
  });

  it("shows workflow name", () => {
    render(<WorkflowStatus />);
    expect(screen.getByText("My Workflow")).toBeInTheDocument();
  });

  it("falls back to file stem when workflowName is empty", () => {
    useWorkflowStore.setState({
      fileName: "/workspace/my-workflow.flightpath.yaml",
      workflowName: "",
    });
    render(<WorkflowStatus />);
    expect(screen.getByText("my-workflow")).toBeInTheDocument();
  });

  it("shows execution state badge when running", () => {
    useWorkflowStore.setState({
      fileName: "/workspace/wf.yaml",
      executionState: EXECUTION_STATES.RUNNING,
    });
    render(<WorkflowStatus />);
    expect(screen.getByText(EXECUTION_STATES.RUNNING)).toBeInTheDocument();
  });

  it("does not show state badge when idle", () => {
    useWorkflowStore.setState({
      fileName: "/workspace/wf.yaml",
      executionState: EXECUTION_STATES.IDLE,
    });
    render(<WorkflowStatus />);
    expect(screen.queryByText(EXECUTION_STATES.IDLE)).not.toBeInTheDocument();
  });

  it("clicking the name button enters edit mode", async () => {
    const user = userEvent.setup();
    render(<WorkflowStatus />);
    // The main button's accessible name is the workflow name text content
    await user.click(screen.getByTitle("Click to edit workflow name"));
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });

  it("pressing Enter in edit mode sends UPDATE_WORKFLOW_NAME", async () => {
    const user = userEvent.setup();
    render(<WorkflowStatus />);
    await user.click(screen.getByTitle("Click to edit workflow name"));
    const input = screen.getByRole("textbox");
    await user.clear(input);
    await user.type(input, "New Name{Enter}");
    expect(postMessageSpy).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.UPDATE_WORKFLOW_NAME,
      workflowName: "New Name",
    });
  });

  it("pressing Escape cancels edit without sending message", async () => {
    const user = userEvent.setup();
    render(<WorkflowStatus />);
    await user.click(screen.getByTitle("Click to edit workflow name"));
    const input = screen.getByRole("textbox");
    await user.clear(input);
    await user.type(input, "Cancelled{Escape}");
    expect(postMessageSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: MESSAGE_TYPES.UPDATE_WORKFLOW_NAME })
    );
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("dropdown toggle sends GET_RECENT_WORKFLOWS and GET_WORKFLOWS_LIST", async () => {
    const user = userEvent.setup();
    render(<WorkflowStatus />);
    await user.click(
      screen.getByRole("button", { name: /Show recent workflows/i })
    );
    expect(postMessageSpy).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.GET_RECENT_WORKFLOWS,
    });
    expect(postMessageSpy).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.GET_WORKFLOWS_LIST,
    });
  });

  it("populates recent workflows list on RECENT_WORKFLOWS message", async () => {
    render(<WorkflowStatus />);
    // Dispatch the RECENT_WORKFLOWS message
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          type: MESSAGE_TYPES.RECENT_WORKFLOWS,
          workflows: [
            {
              workflowName: "Workflow A",
              filePath: "/path/a.yaml",
              executionState: "idle",
            },
          ],
        },
      })
    );
    // Open the dropdown
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: /Show recent workflows/i })
    );
    await waitFor(() => {
      // Count badge or workflow name should appear
      expect(screen.getByText("1")).toBeInTheDocument();
    });
  });
});
