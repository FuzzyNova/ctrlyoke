/**
 * Tests for WorkflowStatus.
 *
 * WorkflowStatus depends on workflowStore, uiStore, settingsStore and vscodeApi.
 * Strategy: preset store state, render, assert what's visible and what's posted.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, act, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkflowStatus } from "@components/workflow/WorkflowStatus";
import { useWorkflowStore } from "@store/workflowStore";
import { useUiStore, type RecentWorkflow } from "@store/uiStore";
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

function setRecentWorkflows(workflows: RecentWorkflow[]): void {
  act(() => {
    useUiStore.getState().setRecentWorkflows(workflows);
  });
}

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

  it("keeps the active pausing workflow in the Running Workflows section when loadedWorkflows is stale", async () => {
    const user = userEvent.setup();
    useWorkflowStore.setState({
      fileName: "/workspace/pausing.flightpath.json",
      workflowName: "Pausing Workflow",
      executionState: EXECUTION_STATES.PAUSING,
      currentStep: 0,
      totalSteps: 1,
    });
    useUiStore.setState({
      activeWorkflowId: "workflow-pausing",
      activeWorkflowWorkingFilePath: "/workspace/pausing.flightpath.json",
      loadedWorkflows: [],
    });

    render(<WorkflowStatus />);
    await user.click(
      screen.getByRole("button", { name: /Show recent workflows/i })
    );

    expect(screen.getByText("Running Workflows")).toBeInTheDocument();
    expect(screen.getAllByText("Pausing Workflow").length).toBeGreaterThan(0);
  });

  it("populates recent workflows list on RECENT_WORKFLOWS message", async () => {
    render(<WorkflowStatus />);
    setRecentWorkflows([
      {
        workflowName: "Workflow A",
        filePath: "/path/a.yaml",
        executionState: "idle",
        isFavorite: false,
      },
    ]);
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

  it("sorts favorite workflows to the top of recent workflows", async () => {
    const user = userEvent.setup();
    render(<WorkflowStatus />);

    setRecentWorkflows([
      {
        workflowName: "Regular Workflow",
        filePath: "/path/regular.yaml",
        executionState: EXECUTION_STATES.IDLE,
        lastModifiedAt: 200,
        isFavorite: false,
      },
      {
        workflowName: "Favorite Workflow",
        filePath: "/path/favorite.yaml",
        executionState: EXECUTION_STATES.IDLE,
        lastModifiedAt: 100,
        isFavorite: true,
      },
    ]);

    await user.click(
      screen.getByRole("button", { name: /Show recent workflows/i })
    );

    const favoriteWorkflow = screen.getByText("Favorite Workflow");
    const regularWorkflow = screen.getByText("Regular Workflow");

    expect(
      favoriteWorkflow.compareDocumentPosition(regularWorkflow) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("toggles a workflow favorite optimistically and posts the toggle message", async () => {
    const user = userEvent.setup();
    render(<WorkflowStatus />);

    setRecentWorkflows([
      {
        workflowName: "Workflow A",
        filePath: "/path/a.yaml",
        executionState: EXECUTION_STATES.IDLE,
        lastModifiedAt: 100,
        isFavorite: false,
      },
      {
        workflowName: "Workflow B",
        filePath: "/path/b.yaml",
        executionState: EXECUTION_STATES.IDLE,
        lastModifiedAt: 200,
        isFavorite: false,
      },
    ]);

    await user.click(
      screen.getByRole("button", { name: /Show recent workflows/i })
    );
    const workflowARow = screen
      .getByText("Workflow A")
      .closest('[role="button"]');
    expect(workflowARow).not.toBeNull();
    await user.click(
      within(workflowARow as HTMLElement).getByRole("button", {
        name: "Add to favorites",
      })
    );

    expect(postMessageSpy).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.TOGGLE_WORKFLOW_FAVORITE,
      filePath: "/path/a.yaml",
    });
    expect(
      screen.getByRole("button", { name: "Remove from favorites" })
    ).toBeInTheDocument();

    const workflowA = screen.getByText("Workflow A");
    const workflowB = screen.getByText("Workflow B");
    expect(
      workflowA.compareDocumentPosition(workflowB) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
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
            isController: true,
          },
        ],
      },
      activeSessionIds: { "workflow-1": "term-1" },
    });

    render(<WorkflowStatus />);
    setRecentWorkflows([
      {
        workflowName: "Completed Workflow",
        filePath: "/workspace/my-workflow.flightpath.yaml",
        executionState: EXECUTION_STATES.COMPLETED,
      },
    ]);

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

    setRecentWorkflows([
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
    ]);

    await user.click(
      screen.getByRole("button", { name: /Show recent workflows/i })
    );
    await user.type(screen.getByRole("searchbox"), "alpha");

    expect(screen.getByText("Alpha Workflow")).toBeInTheDocument();
    expect(screen.queryByText("Beta Workflow")).not.toBeInTheDocument();
  });
});
