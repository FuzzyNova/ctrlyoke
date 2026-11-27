import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { WorkflowStepRow } from "@components/steps/WorkflowStepRow";
import {
  EXECUTION_STATES,
  OUTPUT_HISTORY_KINDS,
  STEP_STATUS,
  STEP_TYPES,
  type StepStatus,
} from "@root/types/DashboardConstants";
import { useUiStore } from "@store/uiStore";
import { useWorkflowStore } from "@store/workflowStore";

vi.mock("@hooks/useVsCodeApi", () => ({ getVsCodeApi: () => ({}) }));
vi.mock("@utils/runNavigation", () => ({ navigateToWorkflowAddress: vi.fn() }));

const step = {
  type: STEP_TYPES.WORKFLOW,
  workflow: "workflows/verify.ctrlyoke.yaml",
  status: STEP_STATUS.RUNNING,
  _runtime: { childWorkflowKey: "child-key", childRunRef: "child-run" },
} as never;

function renderWorkflowRow(
  rowStep = step,
  rowStatus: StepStatus = STEP_STATUS.RUNNING
) {
  return render(
    <WorkflowStepRow
      step={rowStep}
      index={0}
      slotNumber={1}
      currentStep={0}
      executionState={EXECUTION_STATES.RUNNING}
      status={rowStatus}
      isCurrent
      isSelected={false}
      canSetStartPosition={false}
      startPositionDirection="forward"
      setPositionTarget={0}
      isExecutionTargetLocked={false}
      getStepHarnessModel={() => ({})}
      getStepOverrides={() => []}
      onStepClick={vi.fn()}
      onSetStartPosition={vi.fn()}
      onOpenContextMenu={vi.fn()}
    />
  );
}

describe("WorkflowStepRow workflow variant", () => {
  afterEach(() => {
    useUiStore.setState({ loadedWorkflows: [], isViewingHistory: false });
    useWorkflowStore.setState({ liveOrderedEntries: [], historyOutputs: null });
  });

  it("looks up the live child status by runtime workflow key", () => {
    useUiStore.setState({
      loadedWorkflows: [
        {
          id: "child-instance",
          workflowKey: "child-key",
          workflowName: "Verification",
          filePath: "verify.ctrlyoke.yaml",
          executionState: EXECUTION_STATES.PAUSED,
        },
      ] as never,
    });

    renderWorkflowRow();

    expect(screen.getByRole("status")).toHaveTextContent("paused");
    expect(
      screen.getByRole("button", { name: "Open run →" })
    ).toBeInTheDocument();
    expect(
      screen.getByText("workflows/verify.ctrlyoke.yaml")
    ).toBeInTheDocument();
  });

  it("omits the child state badge when the child is not tracked", () => {
    renderWorkflowRow();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("uses the settled child outcome after its live summary is removed", () => {
    useWorkflowStore.setState({
      liveOrderedEntries: [
        {
          kind: OUTPUT_HISTORY_KINDS.SUB_WORKFLOW,
          target: { kind: "queue", stepIndex: 0 },
          timestampMs: 10,
          sequence: 3,
          subWorkflowOutput: {
            childWorkflowKey: "child-key",
            childRunRef: "child-run",
            outcome: { status: "completed" },
          },
        },
      ] as never,
    });

    renderWorkflowRow();

    expect(screen.getByRole("status")).toHaveTextContent("completed");
  });

  it("shows a warning badge for a completed step with a child failure message", () => {
    renderWorkflowRow(
      {
        type: STEP_TYPES.WORKFLOW,
        workflow: "workflows/verify.ctrlyoke.yaml",
        status: STEP_STATUS.COMPLETED,
        _runtime: {
          childWorkflowKey: "child-key",
          childRunRef: "child-run",
          failureMessage: "child failed but parent continued",
        },
      } as never,
      STEP_STATUS.COMPLETED
    );

    expect(screen.getByText("Completed with a warning")).toBeInTheDocument();
  });
});
