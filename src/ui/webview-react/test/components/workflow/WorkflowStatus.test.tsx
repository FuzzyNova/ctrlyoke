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
import { HARNESS_IDS, MESSAGE_TYPES, EXECUTION_STATES } from "@/types/messages";

const postMessageSpy = vi.fn();

beforeEach(() => {
  useWorkflowStore.getState().resetWorkflow();
  useWorkflowStore.temporal.getState().clear();
  useUiStore.getState().resetUi();
  useSettingsStore.getState().resetSettings();
  useTerminalStore.setState({
    sessions: {},
    activeSessionIds: {},
    activeTerminalWorkflows: [],
  });
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
      fileName: "/workspace/my-workflow.ctrlyoke.yaml",
      workflowName: "My Workflow",
    });
  });

  it("shows workflow name", () => {
    render(<WorkflowStatus />);
    expect(screen.getByText("My Workflow")).toBeInTheDocument();
  });

  it("falls back to file stem when workflowName is empty", () => {
    useWorkflowStore.setState({
      fileName: "/workspace/my-workflow.ctrlyoke.yaml",
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
      fileName: "/workspace/pausing.ctrlyoke.json",
      workflowName: "Pausing Workflow",
      executionState: EXECUTION_STATES.PAUSING,
      currentStep: 0,
      totalSteps: 1,
    });
    useUiStore.setState({
      activeWorkflowId: "workflow-pausing",
      activeWorkflowWorkingFilePath: "/workspace/pausing.ctrlyoke.json",
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
          filePath: "/workspace/running.ctrlyoke.yaml",
          executionState: EXECUTION_STATES.RUNNING,
          currentStep: 0,
          totalSteps: 1,
          startedAt: Date.now(),
        },
      ],
    });
    useTerminalStore.setState({
      activeTerminalWorkflows: [
        {
          workflowId: "workflow-1",
          workingFilePath: "/workspace/running.ctrlyoke.yaml",
        },
      ],
    });

    render(<WorkflowStatus />);
    await user.click(
      screen.getByRole("button", { name: /Show recent workflows/i })
    );

    expect(
      screen.getAllByLabelText("Terminal session is still running").length
    ).toBeGreaterThan(0);
  });

  it("marks a recent (unloaded) workflow row by working file path when its terminal is still running", async () => {
    const user = userEvent.setup();
    useUiStore.setState({
      activeWorkflowId: "workflow-2",
    });
    // The completed workflow is no longer loaded, but the global active-terminal
    // set still reports a lingering PTY for its working file path — the row must
    // light up purely from that broadcast, with no per-session store state.
    useTerminalStore.setState({
      activeTerminalWorkflows: [
        {
          workflowId: "workflow-1",
          workingFilePath: "/workspace/my-workflow.ctrlyoke.yaml",
        },
      ],
    });

    render(<WorkflowStatus />);
    setRecentWorkflows([
      {
        workflowName: "Completed Workflow",
        filePath: "/workspace/my-workflow.ctrlyoke.yaml",
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

  it("augments search results with the state filter", async () => {
    const user = userEvent.setup();
    render(<WorkflowStatus />);

    setRecentWorkflows([
      {
        workflowName: "Stopped Workflow",
        filePath: "/path/stopped.yaml",
        executionState: EXECUTION_STATES.STOPPED,
      },
      {
        workflowName: "Completed Workflow",
        filePath: "/path/completed.yaml",
        executionState: EXECUTION_STATES.COMPLETED,
      },
    ]);

    await user.click(
      screen.getByRole("button", { name: /Show recent workflows/i })
    );
    await user.click(screen.getByRole("button", { name: "Filter workflows" }));
    await user.click(document.getElementById("workflow-state-filter")!);
    await user.click(
      within(document.body).getByRole("button", {
        name: new RegExp(EXECUTION_STATES.COMPLETED),
      })
    );

    expect(screen.getByText("Stopped Workflow")).toBeInTheDocument();
    expect(screen.queryByText("Completed Workflow")).not.toBeInTheDocument();
  });

  it("filters recent workflows by harness", async () => {
    const user = userEvent.setup();
    render(<WorkflowStatus />);

    setRecentWorkflows([
      {
        workflowName: "Claude Workflow",
        filePath: "/path/claude.yaml",
        executionState: EXECUTION_STATES.IDLE,
        harness: HARNESS_IDS.CLAUDE_CLI,
      },
      {
        workflowName: "Codex Workflow",
        filePath: "/path/codex.yaml",
        executionState: EXECUTION_STATES.IDLE,
        harness: HARNESS_IDS.CODEX_CLI,
      },
    ]);

    await user.click(
      screen.getByRole("button", { name: /Show recent workflows/i })
    );
    await user.click(screen.getByRole("button", { name: "Filter workflows" }));
    await user.click(document.getElementById("workflow-harness-filter")!);
    await user.click(
      within(document.body)
        .getAllByRole("button", { name: /Codex/ })
        .find((button) => button.textContent === "Codex")!
    );

    expect(screen.getByText("Claude Workflow")).toBeInTheDocument();
    expect(screen.queryByText("Codex Workflow")).not.toBeInTheDocument();
  });

  it("closing the filter drawer preserves active filters until Clear is clicked", async () => {
    const user = userEvent.setup();
    render(<WorkflowStatus />);

    setRecentWorkflows([
      {
        workflowName: "Recent Workflow",
        filePath: "/path/recent.yaml",
        executionState: EXECUTION_STATES.IDLE,
        lastModifiedAt: Date.now(),
      },
      {
        workflowName: "Old Workflow",
        filePath: "/path/old.yaml",
        executionState: EXECUTION_STATES.IDLE,
        lastModifiedAt: Date.now() - 40 * 24 * 60 * 60 * 1000,
      },
    ]);

    await user.click(
      screen.getByRole("button", { name: /Show recent workflows/i })
    );
    await user.click(screen.getByRole("button", { name: "Filter workflows" }));
    await user.selectOptions(
      screen.getByLabelText("Workflow date preset"),
      "last7"
    );

    expect(screen.getByText("Recent Workflow")).toBeInTheDocument();
    expect(screen.queryByText("Old Workflow")).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Close workflow filters" })
    );

    expect(screen.getByText("Recent Workflow")).toBeInTheDocument();
    expect(screen.queryByText("Old Workflow")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Filter workflows" }));
    await user.click(
      screen.getByRole("button", { name: "Clear workflow filters" })
    );

    expect(screen.getByText("Recent Workflow")).toBeInTheDocument();
    expect(screen.getByText("Old Workflow")).toBeInTheDocument();
  });

  it("filters recent workflows to favorites only", async () => {
    const user = userEvent.setup();
    render(<WorkflowStatus />);

    setRecentWorkflows([
      {
        workflowName: "Favorite Workflow",
        filePath: "/path/favorite.yaml",
        executionState: EXECUTION_STATES.IDLE,
        isFavorite: true,
      },
      {
        workflowName: "Regular Workflow",
        filePath: "/path/regular.yaml",
        executionState: EXECUTION_STATES.IDLE,
        isFavorite: false,
      },
    ]);

    await user.click(
      screen.getByRole("button", { name: /Show recent workflows/i })
    );
    await user.click(screen.getByRole("button", { name: "Filter workflows" }));
    await user.click(screen.getByRole("button", { name: "Favorites only" }));

    expect(screen.getByText("Favorite Workflow")).toBeInTheDocument();
    expect(screen.queryByText("Regular Workflow")).not.toBeInTheDocument();
  });
});
