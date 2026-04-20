/**
 * Tests for WorkflowStatus.
 *
 * WorkflowStatus depends on workflowStore, uiStore, settingsStore and vscodeApi.
 * Strategy: preset store state, render, assert what's visible and what's posted.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkflowStatus } from "@components/workflow/WorkflowStatus";
import { useWorkflowStore } from "@store/workflowStore";
import { useUiStore } from "@store/uiStore";
import { useSettingsStore } from "@store/settingsStore";
import { useTerminalStore } from "@store/terminalStore";
import {
  MESSAGE_TYPES,
  EXECUTION_STATES,
  SESSION_KINDS,
  TERMINAL_SESSION_STATUS,
} from "@/types/messages";

const postMessageSpy = vi.fn();

beforeEach(() => {
  useWorkflowStore.getState().resetWorkflow();
  useWorkflowStore.temporal.getState().clear();
  useUiStore.getState().resetUi();
  useSettingsStore.getState().resetSettings();
  useTerminalStore.setState({ sessions: {}, activeSessionIds: {} });
  (
    window.vscodeApi as unknown as { postMessage: ReturnType<typeof vi.fn> }
  ).postMessage = postMessageSpy;
  postMessageSpy.mockClear();
});

describe("WorkflowStatus — empty state", () => {
  it("shows 'New Workflow' when fileName is null", () => {
    render(<WorkflowStatus />);
    // The display name button shows "New Workflow"; the hidden RecentWorkflows
    // dropdown also renders a "New Workflow" button (CSS-hidden), so use
    // getAllByText and assert at least one match is in the document.
    const matches = screen.getAllByText(/New Workflow/i);
    expect(matches.length).toBeGreaterThan(0);
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
    // jsdom always reports 0-width elements, so isNarrow=true and the badge
    // renders an icon with the state as a title rather than visible text.
    expect(screen.getByTitle(EXECUTION_STATES.RUNNING)).toBeInTheDocument();
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
    act(() => {
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
    });
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

  it("marks loaded workflow rows with a terminal icon when a PTY session is running", async () => {
    const user = userEvent.setup();
    useUiStore.setState({
      activeWorkflowId: "workflow-1",
      loadedWorkflows: [
        {
          id: "workflow-1",
          workflowName: "Running Workflow",
          filePath: "/workspace/running.flightpath.yaml",
          executionState: EXECUTION_STATES.RUNNING,
          currentStep: 0,
          totalSteps: 1,
          startedAt: Date.now(),
        },
      ],
    });
    useTerminalStore.setState({
      sessions: {
        "workflow-1": [
          {
            id: "term-1",
            workflowId: "workflow-1",
            stepName: "Step 1",
            kind: SESSION_KINDS.AI_CLI,
            status: TERMINAL_SESSION_STATUS.RUNNING,
            pendingOutput: [],
            isController: true,
          },
        ],
      },
      activeSessionIds: { "workflow-1": "term-1" },
    });

    render(<WorkflowStatus />);
    await user.click(
      screen.getByRole("button", { name: /Show recent workflows/i })
    );

    expect(
      screen.getAllByLabelText("Terminal session is still running").length
    ).toBeGreaterThan(0);
  });

  it("marks the current completed workflow row when its terminal is still running", async () => {
    const user = userEvent.setup();
    useUiStore.setState({
      activeWorkflowId: "workflow-1",
    });
    useTerminalStore.setState({
      sessions: {
        "workflow-1": [
          {
            id: "term-1",
            workflowId: "workflow-1",
            stepName: "Shell",
            kind: SESSION_KINDS.SHELL,
            status: TERMINAL_SESSION_STATUS.RUNNING,
            pendingOutput: [],
            isController: true,
          },
        ],
      },
      activeSessionIds: { "workflow-1": "term-1" },
    });

    render(<WorkflowStatus />);
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            type: MESSAGE_TYPES.RECENT_WORKFLOWS,
            workflows: [
              {
                workflowName: "Completed Workflow",
                filePath: "/workspace/my-workflow.flightpath.yaml",
                executionState: EXECUTION_STATES.COMPLETED,
              },
            ],
          },
        })
      );
    });

    await user.click(
      screen.getByRole("button", { name: /Show recent workflows/i })
    );

    expect(
      screen.getAllByLabelText("Terminal session is still running").length
    ).toBeGreaterThan(0);
  });

  it("filters recent workflows from the header search", async () => {
    const user = userEvent.setup();
    render(<WorkflowStatus />);

    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            type: MESSAGE_TYPES.RECENT_WORKFLOWS,
            workflows: [
              {
                workflowName: "Alpha Workflow",
                filePath: "/path/alpha.yaml",
                executionState: EXECUTION_STATES.IDLE,
              },
              {
                workflowName: "Beta Workflow",
                filePath: "/path/beta.yaml",
                executionState: EXECUTION_STATES.IDLE,
              },
            ],
          },
        })
      );
    });

    await user.click(
      screen.getByRole("button", { name: /Show recent workflows/i })
    );
    await user.type(screen.getByRole("searchbox"), "alpha");

    expect(screen.getByText("Alpha Workflow")).toBeInTheDocument();
    expect(screen.queryByText("Beta Workflow")).not.toBeInTheDocument();
  });
});
