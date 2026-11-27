import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  useWorkflowContextMenu,
  type WorkflowContextMenuTarget,
} from "@hooks/useWorkflowContextMenu";
import { useUiStore } from "@store/uiStore";
import { useWorkflowStore } from "@store/workflowStore";
import { useSettingsStore } from "@store/settingsStore";
import { useTerminalStore } from "@store/terminalStore";
import {
  APPEND_MODES,
  EXECUTION_STATES,
  FINAL_STEP_PHASES,
  MESSAGE_TYPES,
  PARALLEL_DISPATCH_REFUSALS,
  QUEUE_POSITION,
  SUB_WORKFLOW_QUEUE_LABELS,
  WORKFLOW_VIEW_ADDRESS_KIND,
  type ExecutionState,
} from "@root/types/DashboardConstants";
import type { WorkflowSummary } from "@root/types/CtrlYokeTypes";

const host = vi.hoisted(() => ({ standalone: false }));

vi.mock("@hooks/useVsCodeApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hooks/useVsCodeApi")>();
  return {
    ...actual,
    get isStandalone() {
      return host.standalone;
    },
  };
});

vi.mock("@utils/hostedApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@utils/hostedApi")>();
  return {
    ...actual,
    hostedFetch: vi.fn().mockResolvedValue({ files: [], isGitRepo: false }),
  };
});

const runAddress = {
  workflowKey: "workflow-1" as never,
  kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
  runRef: "run-2" as never,
};

const target: WorkflowContextMenuTarget = {
  address: runAddress,
  workflowName: "Workflow 1",
  scope: "run",
  isExecuting: false,
};

const mutation = {
  address: runAddress,
  expectedDefinitionRevision: 3,
  expectedDescriptorRevision: 5,
};

function TestHarness({
  menuTarget = target,
}: {
  menuTarget?: WorkflowContextMenuTarget;
}) {
  const { openContextMenu, workflowContextMenuPortal } = useWorkflowContextMenu(
    {
      onDuplicate: vi.fn(),
      onToggleFavorite: vi.fn(),
      onDelete: vi.fn(),
      onCloseDropdown: vi.fn(),
      onEditSchedule: vi.fn(),
    }
  );
  return (
    <>
      <button
        onClick={(event) =>
          openContextMenu(20, 20, menuTarget, event.currentTarget)
        }
      >
        Open menu
      </button>
      {workflowContextMenuPortal}
    </>
  );
}

function displayRun(executionState: ExecutionState): void {
  useUiStore.setState({
    displayedViewAddress: runAddress,
    displayedDefinitionRevision: 3,
    displayedDescriptorRevision: 5,
  });
  // A running run has a step in flight; the switcher reads it as the
  // prompt editor's Run in Parallel does.
  useWorkflowStore.setState({
    executionState,
    activeStepIndices: executionState === EXECUTION_STATES.RUNNING ? [0] : [],
  });
}

function openMenu(menuTarget?: WorkflowContextMenuTarget): void {
  render(<TestHarness menuTarget={menuTarget} />);
  fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
}

function menuItem(name: string): HTMLElement | null {
  return screen.queryByRole("menuitem", { name });
}

function setParallelWidth(width: number): void {
  useSettingsStore.setState((state) => ({
    globalSettings: {
      ...state.globalSettings,
      effectiveParallelGroupWidth: width,
    },
  }));
}

describe("useWorkflowContextMenu sub-workflow queue items", () => {
  let postMessage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    host.standalone = false;
    useUiStore.getState().resetUi();
    useWorkflowStore.setState({
      executionState: EXECUTION_STATES.IDLE,
      finalStepPhase: null,
      activeStepIndices: [],
    });
    setParallelWidth(4);
    useTerminalStore.getState().setActiveTerminalWorkflows([]);
    postMessage = vi.fn();
    Object.defineProperty(window, "vscodeApi", {
      configurable: true,
      value: { postMessage, getState: vi.fn(), setState: vi.fn() },
    });
  });

  afterEach(() => cleanup());

  it.each([
    EXECUTION_STATES.RUNNING,
    EXECUTION_STATES.PAUSING,
    EXECUTION_STATES.PAUSED,
    EXECUTION_STATES.COMPLETED,
    EXECUTION_STATES.STOPPED,
    EXECUTION_STATES.ERROR,
  ])("offers Queue Next on the displayed run while %s", (state) => {
    displayRun(state);
    openMenu();
    expect(menuItem(SUB_WORKFLOW_QUEUE_LABELS.queueNext)).toBeEnabled();
    expect(Boolean(menuItem(SUB_WORKFLOW_QUEUE_LABELS.runAlongside))).toBe(
      state === EXECUTION_STATES.RUNNING
    );
  });

  it("offers neither item on an idle or unstarted run", () => {
    displayRun(EXECUTION_STATES.IDLE);
    openMenu();
    expect(menuItem(SUB_WORKFLOW_QUEUE_LABELS.queueNext)).toBeNull();
    cleanup();

    displayRun(EXECUTION_STATES.STOPPED);
    openMenu({ ...target, isUnstarted: true });
    expect(menuItem(SUB_WORKFLOW_QUEUE_LABELS.queueNext)).toBeNull();
  });

  it("offers neither item on a row that is not the displayed run", () => {
    displayRun(EXECUTION_STATES.RUNNING);
    openMenu({
      ...target,
      address: { ...runAddress, runRef: "run-1" as never },
    });
    expect(menuItem(SUB_WORKFLOW_QUEUE_LABELS.queueNext)).toBeNull();
    expect(menuItem(SUB_WORKFLOW_QUEUE_LABELS.runAlongside)).toBeNull();
  });

  it("offers neither item on a draft", () => {
    const draft = {
      workflowKey: "workflow-1" as never,
      kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
    };
    useUiStore.setState({ displayedViewAddress: draft });
    useWorkflowStore.setState({ executionState: EXECUTION_STATES.COMPLETED });
    openMenu({ ...target, address: draft });
    expect(menuItem(SUB_WORKFLOW_QUEUE_LABELS.queueNext)).toBeNull();
  });

  it("disables Run Alongside in the final step and at width 1", () => {
    displayRun(EXECUTION_STATES.RUNNING);
    useWorkflowStore.setState({ finalStepPhase: FINAL_STEP_PHASES.FINAL_STEP });
    openMenu();
    const alongside = menuItem(SUB_WORKFLOW_QUEUE_LABELS.runAlongside)!;
    expect(alongside).toBeDisabled();
    expect(alongside).toHaveAttribute(
      "title",
      PARALLEL_DISPATCH_REFUSALS.finalStep
    );
    expect(menuItem(SUB_WORKFLOW_QUEUE_LABELS.queueNext)).toBeEnabled();
    cleanup();

    useWorkflowStore.setState({ finalStepPhase: FINAL_STEP_PHASES.QUEUE });
    setParallelWidth(1);
    openMenu();
    expect(menuItem(SUB_WORKFLOW_QUEUE_LABELS.runAlongside)).toHaveAttribute(
      "title",
      PARALLEL_DISPATCH_REFUSALS.widthOne
    );
  });

  it("disables Run Alongside while no step is running, as Run in Parallel does", () => {
    // Between steps the run is RUNNING with nothing in flight.
    displayRun(EXECUTION_STATES.RUNNING);
    useWorkflowStore.setState({ activeStepIndices: [] });
    openMenu();
    const alongside = menuItem(SUB_WORKFLOW_QUEUE_LABELS.runAlongside)!;
    expect(alongside).toBeDisabled();
    expect(alongside).toHaveAttribute(
      "title",
      PARALLEL_DISPATCH_REFUSALS.noStepRunning
    );
    expect(menuItem(SUB_WORKFLOW_QUEUE_LABELS.queueNext)).toBeEnabled();
  });

  it("disables Queue Next, not Run Alongside, on an externally executing run", () => {
    displayRun(EXECUTION_STATES.RUNNING);
    useUiStore.setState({
      loadedWorkflows: [
        {
          id: "instance-1",
          workflowKey: "workflow-1",
          runRef: "run-2",
          workflowName: "Workflow 1",
          filePath: "/w.ctrlyoke.yaml",
          executionState: EXECUTION_STATES.RUNNING,
          currentStep: 0,
          totalSteps: 1,
          externalOwner: { pid: 1 },
        } as unknown as WorkflowSummary,
      ],
    });
    openMenu();
    expect(menuItem(SUB_WORKFLOW_QUEUE_LABELS.queueNext)).toBeDisabled();
    expect(menuItem(SUB_WORKFLOW_QUEUE_LABELS.queueNext)).toHaveAttribute(
      "title",
      SUB_WORKFLOW_QUEUE_LABELS.externalRun
    );
    expect(menuItem(SUB_WORKFLOW_QUEUE_LABELS.runAlongside)).toBeEnabled();
  });

  it("asks the extension's native picker for Queue Next in the VS Code panel", () => {
    displayRun(EXECUTION_STATES.COMPLETED);
    openMenu();
    fireEvent.click(menuItem(SUB_WORKFLOW_QUEUE_LABELS.queueNext)!);
    expect(postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.APPEND_FILE,
      appendMode: APPEND_MODES.SUB_WORKFLOW,
      position: QUEUE_POSITION.END,
      mutation,
    });
  });

  it("asks the native picker for Run Alongside with parallelWithCurrent", () => {
    displayRun(EXECUTION_STATES.RUNNING);
    openMenu();
    fireEvent.click(menuItem(SUB_WORKFLOW_QUEUE_LABELS.runAlongside)!);
    expect(postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.APPEND_FILE,
      appendMode: APPEND_MODES.SUB_WORKFLOW,
      position: QUEUE_POSITION.PARALLEL_WITH_CURRENT,
      mutation,
    });
  });

  it("picks through WorkflowFilePickerModal in the hosted browser", async () => {
    host.standalone = true;
    displayRun(EXECUTION_STATES.RUNNING);
    openMenu();
    fireEvent.click(menuItem(SUB_WORKFLOW_QUEUE_LABELS.runAlongside)!);
    expect(postMessage).not.toHaveBeenCalled();

    await waitFor(() =>
      expect(
        screen.getByText(SUB_WORKFLOW_QUEUE_LABELS.pickerAlongsideTitle)
      ).toBeInTheDocument()
    );
    fireEvent.change(screen.getByLabelText("Or enter a path"), {
      target: { value: "lanes/docs.ctrlyoke.yaml" },
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: SUB_WORKFLOW_QUEUE_LABELS.pickerAlongsideAction,
      })
    );
    expect(postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.APPEND_FILE,
      filePath: "lanes/docs.ctrlyoke.yaml",
      appendMode: APPEND_MODES.SUB_WORKFLOW,
      position: QUEUE_POSITION.PARALLEL_WITH_CURRENT,
      mutation,
    });
    await waitFor(() =>
      expect(
        screen.queryByText(SUB_WORKFLOW_QUEUE_LABELS.pickerAlongsideTitle)
      ).toBeNull()
    );
  });

  it("posts the run the item was chosen on, even after a switch while the picker is open", async () => {
    host.standalone = true;
    displayRun(EXECUTION_STATES.COMPLETED);
    openMenu();
    fireEvent.click(menuItem(SUB_WORKFLOW_QUEUE_LABELS.queueNext)!);
    await waitFor(() =>
      expect(
        screen.getByText(SUB_WORKFLOW_QUEUE_LABELS.pickerTitle)
      ).toBeInTheDocument()
    );

    // Another client's action, or the user, moves this view on meanwhile.
    act(() => {
      useUiStore.setState({
        displayedViewAddress: {
          workflowKey: "workflow-2" as never,
          kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
          runRef: "run-9" as never,
        },
        displayedDefinitionRevision: 11,
        displayedDescriptorRevision: 12,
      });
    });
    fireEvent.change(screen.getByLabelText("Or enter a path"), {
      target: { value: "flows/next.ctrlyoke.yaml" },
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: SUB_WORKFLOW_QUEUE_LABELS.pickerAction,
      })
    );
    expect(postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.APPEND_FILE,
      filePath: "flows/next.ctrlyoke.yaml",
      appendMode: APPEND_MODES.SUB_WORKFLOW,
      position: QUEUE_POSITION.END,
      mutation,
    });
  });
});
