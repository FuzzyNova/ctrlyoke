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
  HARNESS_IDS,
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

function setRecentWorkflows(
  workflows: Array<
    Omit<RecentWorkflow, "address"> & {
      address?: RecentWorkflow["address"];
      filePath?: string;
    }
  >
): void {
  act(() => {
    useUiStore.getState().setRecentWorkflows(
      workflows.map(({ filePath: _filePath, ...workflow }, index) => ({
        ...workflow,
        address:
          workflow.address ??
          ({ workflowKey: `test-${index}` as never, kind: "draft" } as const),
      }))
    );
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

  it("attaches the displayed run mutation to a rename so it targets the viewed run", async () => {
    const user = userEvent.setup();
    useUiStore.setState({
      displayedViewAddress: {
        workflowKey: "wf-1" as never,
        kind: "run",
        runRef: "run-1" as never,
      },
      displayedDefinitionRevision: 2,
      displayedDescriptorRevision: 5,
    });
    render(<WorkflowStatus />);
    await user.click(screen.getByTitle("Click to edit workflow name"));
    const input = screen.getByRole("textbox");
    await user.clear(input);
    await user.type(input, "Renamed Run{Enter}");
    expect(postMessageSpy).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.UPDATE_WORKFLOW_NAME,
      workflowName: "Renamed Run",
      mutation: {
        address: { workflowKey: "wf-1", kind: "run", runRef: "run-1" },
        expectedDefinitionRevision: 2,
        expectedDescriptorRevision: 5,
      },
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

  it("keeps the active pausing workflow visible in the unified list when loadedWorkflows is stale", async () => {
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

    expect(screen.getAllByText("Pausing Workflow").length).toBeGreaterThan(0);
    expect(
      document.querySelector(".running-workflow-item")
    ).toBeInTheDocument();
  });

  it("renders running rows in the pinned region, separate from the recent scroll container", async () => {
    const user = userEvent.setup();
    useWorkflowStore.setState({
      fileName: "/workspace/running.ctrlyoke.json",
      workflowName: "Running Workflow",
      executionState: EXECUTION_STATES.RUNNING,
      currentStep: 0,
      totalSteps: 1,
    });
    useUiStore.setState({
      activeWorkflowId: "workflow-running",
      activeWorkflowWorkingFilePath: "/workspace/running.ctrlyoke.json",
      loadedWorkflows: [],
    });

    render(<WorkflowStatus />);
    setRecentWorkflows([
      {
        workflowName: "Old Workflow",
        filePath: "/path/old.yaml",
        executionState: "completed",
        isFavorite: false,
      },
    ]);
    await user.click(
      screen.getByRole("button", { name: /Show recent workflows/i })
    );

    // The pinned running region exists and holds the running row — never the
    // recent scroll container, so it stays visible regardless of recent scroll.
    const runningRegion = document.querySelector(".running-workflows-region");
    expect(runningRegion).toBeInTheDocument();
    expect(
      runningRegion?.querySelector(".running-workflow-item")
    ).toBeInTheDocument();
    expect(
      document
        .querySelector(".workflow-menu-items")
        ?.querySelector(".running-workflow-item")
    ).toBeNull();
  });

  it("shows no pinned running region when nothing is running", async () => {
    const user = userEvent.setup();
    render(<WorkflowStatus />);
    setRecentWorkflows([
      {
        workflowName: "Only Recent",
        filePath: "/path/only.yaml",
        executionState: "completed",
        isFavorite: false,
      },
    ]);
    await user.click(
      screen.getByRole("button", { name: /Show recent workflows/i })
    );

    expect(
      document.querySelector(".running-workflows-region")
    ).not.toBeInTheDocument();
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

  it("closes the dropdown without reloading when selecting the current workflow", async () => {
    const user = userEvent.setup();
    useUiStore.setState({
      displayedViewAddress: { workflowKey: "test-0" as never, kind: "draft" },
    });
    setRecentWorkflows([
      {
        workflowName: "My Workflow",
        filePath: "/workspace/my-workflow.ctrlyoke.yaml",
        executionState: EXECUTION_STATES.IDLE,
      },
    ]);
    render(<WorkflowStatus />);

    const dropdownTrigger = screen.getByRole("button", {
      name: /Show recent workflows/i,
    });
    await user.click(dropdownTrigger);
    await user.click(
      within(screen.getByTitle("test-0")).getByRole("button", {
        name: "My Workflow",
      })
    );

    expect(postMessageSpy).not.toHaveBeenCalledWith({
      type: MESSAGE_TYPES.LOAD_RUN_VIEW,
      address: { workflowKey: "test-0", kind: "draft" },
    });
    expect(document.querySelector(".workflow-dropdown-menu")).toHaveClass(
      "pointer-events-none"
    );
  });

  it("selects a recent workflow through the run-view loader", async () => {
    const user = userEvent.setup();
    const address = {
      workflowKey: "test-1" as never,
      kind: "run" as const,
      runRef: "run-2026-07-20T12-00-00-000Z" as never,
    };
    useUiStore.setState({
      displayedViewAddress: { workflowKey: "test-0" as never, kind: "draft" },
      runSummaries: [],
    });
    useWorkflowStore.getState().setExecutionState(EXECUTION_STATES.RUNNING);
    setRecentWorkflows([
      {
        address,
        workflowName: "Another Workflow",
        executionState: EXECUTION_STATES.COMPLETED,
      },
    ]);
    render(<WorkflowStatus />);

    await user.click(
      screen.getByRole("button", { name: /Show recent workflows/i })
    );
    await user.click(
      within(screen.getByTitle("test-1")).getByRole("button", {
        name: "Another Workflow",
      })
    );

    expect(postMessageSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MESSAGE_TYPES.LOAD_RUN_VIEW,
        address,
        requestId: expect.any(String),
      })
    );
    expect(useUiStore.getState().displayedViewAddress).toEqual(address);
    expect(useWorkflowStore.getState().executionState).toBe(
      EXECUTION_STATES.COMPLETED
    );
  });

  it("keeps a completed workflow selected after it leaves Running Workflows", async () => {
    const user = userEvent.setup();
    const workingFilePath = "C:\\workspace\\.ctrlyoke\\workflow.ctrlyoke.json";
    useUiStore.setState({
      activeWorkflowId: "workflow-1",
      activeWorkflowWorkingFilePath: workingFilePath,
      displayedViewAddress: { workflowKey: "test-0" as never, kind: "draft" },
      loadedWorkflows: [
        {
          id: "workflow-1",
          workflowName: "My Workflow",
          filePath: "C:\\workspace\\workflow.ctrlyoke.yaml",
          workingFilePath,
          executionState: EXECUTION_STATES.RUNNING,
          currentStep: 0,
          totalSteps: 1,
        },
      ],
    });
    render(<WorkflowStatus />);

    await user.click(
      screen.getByRole("button", { name: /Show recent workflows/i })
    );

    act(() => {
      useUiStore.getState().setLoadedWorkflows([]);
      useUiStore.getState().setRecentWorkflows([
        {
          address: { workflowKey: "test-0" as never, kind: "draft" },
          workflowName: "My Workflow",
          executionState: EXECUTION_STATES.COMPLETED,
        },
      ]);
    });

    expect(screen.getByTitle("test-0")).toHaveClass("fp-dropdown-row-selected");
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
      .closest(".workflow-menu-item");
    expect(workflowARow).not.toBeNull();
    await user.click(
      within(workflowARow as HTMLElement).getByRole("button", {
        name: "Add to favorites",
      })
    );

    expect(postMessageSpy).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.TOGGLE_WORKFLOW_FAVORITE,
      address: { workflowKey: "test-0", kind: "draft" },
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

  it("hides the terminal icon in the narrow header while keeping it on the loaded workflow row", async () => {
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
          workflowKey: "test-0" as never,
          runRef: "run-2026-01-01T00-00-00-000Z" as never,
        },
      ],
    });

    render(<WorkflowStatus />);
    await user.click(
      screen.getByRole("button", { name: /Show recent workflows/i })
    );

    expect(
      within(screen.getByTitle("Click to edit workflow name")).queryByLabelText(
        "Terminal session is still running"
      )
    ).not.toBeInTheDocument();
    expect(
      screen.getAllByLabelText("Terminal session is still running").length
    ).toBeGreaterThan(0);
  });

  it("shows the terminal icon in the wide header as soon as the current workflow starts a terminal", () => {
    const getBoundingClientRect = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue({ width: 500 } as DOMRect);
    useUiStore.getState().setActiveWorkflowId("workflow-1");

    render(<WorkflowStatus />);

    act(() => {
      useTerminalStore.getState().addSession({
        id: "session-1",
        workflowId: "workflow-1",
        stepName: "Step 1",
        kind: SESSION_KINDS.AI_CLI,
        status: TERMINAL_SESSION_STATUS.RUNNING,
        isController: true,
      });
    });

    expect(
      within(screen.getByTitle("Click to edit workflow name")).getByLabelText(
        "Terminal session is still running"
      )
    ).toBeInTheDocument();
    getBoundingClientRect.mockRestore();
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
          workflowKey: "test-0" as never,
          runRef: "run-2026-01-01T00-00-00-000Z" as never,
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
