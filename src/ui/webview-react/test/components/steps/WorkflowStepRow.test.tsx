import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  WorkflowStepRow,
  type StepHarnessModel,
} from "@components/steps/WorkflowStepRow";
import {
  EXECUTION_STATES,
  OUTPUT_HISTORY_KINDS,
  STEP_STATUS,
  STEP_TYPES,
  SUB_WORKFLOW_DASHBOARD_LABELS,
  WORKTREE_MERGE_OUTCOMES,
  WORKTREE_MODES,
  type StepStatus,
  type WorktreeMergeOutcome,
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
  rowStatus: StepStatus = STEP_STATUS.RUNNING,
  harnessModel: StepHarnessModel = {}
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
      getStepHarnessModel={() => harnessModel}
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

describe("WorkflowStepRow inline lane variant", () => {
  afterEach(() => {
    useUiStore.setState({ loadedWorkflows: [], isViewingHistory: false });
    useWorkflowStore.setState({ liveOrderedEntries: [], historyOutputs: null });
  });

  const lanePrompt = "Implement the lint rules, run the tests, then commit.";

  function laneStep(
    runtime: Record<string, unknown> = {
      childWorkflowKey: "lane-key",
      childRunRef: "lane-run",
    },
    name?: string
  ) {
    return {
      type: STEP_TYPES.WORKFLOW,
      ...(name ? { name } : {}),
      workflow: {
        prompt: lanePrompt,
        worktree: { mode: WORKTREE_MODES.MANAGED, merge: true },
      },
      _runtime: runtime,
    } as never;
  }

  function settleLane(
    mergeOutcome?: WorktreeMergeOutcome,
    conflictFiles?: string[]
  ) {
    useWorkflowStore.setState({
      liveOrderedEntries: [
        {
          kind: OUTPUT_HISTORY_KINDS.SUB_WORKFLOW,
          target: { kind: "queue", stepIndex: 0 },
          timestampMs: 10,
          sequence: 3,
          subWorkflowOutput: {
            childWorkflowKey: "lane-key",
            childRunRef: "lane-run",
            outcome: { status: "completed" },
            worktree: {
              mode: WORKTREE_MODES.MANAGED,
              branchName: "ctrlyoke/lane/run-1",
              baseCommit: "base",
              ...(mergeOutcome ? { mergeOutcome } : {}),
              ...(conflictFiles ? { conflictFiles } : {}),
            },
          },
        },
      ] as never,
    });
  }

  const laneHarness: StepHarnessModel = {
    harnessId: "claude-cli",
    harnessLabel: "Claude Code",
    harnessIsDefault: true,
    modelLabel: "sonnet",
    modelIsDefault: true,
  };

  it("titles a running lane by its inner prompt with harness, model and a worktree badge", () => {
    useUiStore.setState({
      loadedWorkflows: [
        {
          id: "lane-instance",
          workflowKey: "lane-key",
          workflowName: "Lane",
          filePath: "",
          executionState: EXECUTION_STATES.RUNNING,
          worktree: {
            branchName: "ctrlyoke/lane/run-1",
            worktreePath: "/repo.worktrees/lane",
          },
        },
      ] as never,
    });

    renderWorkflowRow(laneStep(), STEP_STATUS.RUNNING, laneHarness);

    expect(screen.getByText(lanePrompt)).toBeInTheDocument();
    expect(screen.getByText("Claude Code")).toBeInTheDocument();
    expect(screen.getByText("sonnet")).toBeInTheDocument();
    expect(
      screen.getByTestId("workflow-step-worktree-badge")
    ).toHaveTextContent("ctrlyoke/lane/run-1");
    expect(screen.getByRole("status")).toHaveTextContent("running");
    expect(
      screen.queryByText(SUB_WORKFLOW_DASHBOARD_LABELS.mergeConflict)
    ).toBeNull();
  });

  it("labels the worktree badge generically before the child has a branch", () => {
    renderWorkflowRow(laneStep({}), STEP_STATUS.PENDING, laneHarness);

    expect(
      screen.getByTestId("workflow-step-worktree-badge")
    ).toHaveTextContent(SUB_WORKFLOW_DASHBOARD_LABELS.worktree);
  });

  it("shows a named lane's prompt as its subtitle", () => {
    renderWorkflowRow(laneStep({}, "Lint rules"), STEP_STATUS.PENDING);

    expect(screen.getByText("Lint rules")).toBeInTheDocument();
    expect(screen.getByText(lanePrompt)).toBeInTheDocument();
  });

  it("reports a merged lane quietly, with its branch from the settlement", () => {
    settleLane(WORKTREE_MERGE_OUTCOMES.FAST_FORWARD);

    renderWorkflowRow(laneStep(), STEP_STATUS.COMPLETED, laneHarness);

    expect(
      screen.getByTestId("workflow-step-worktree-badge")
    ).toHaveTextContent("ctrlyoke/lane/run-1");
    expect(screen.getByRole("status")).toHaveTextContent("completed");
    for (const label of [
      SUB_WORKFLOW_DASHBOARD_LABELS.mergeConflict,
      SUB_WORKFLOW_DASHBOARD_LABELS.mergeBlocked,
      SUB_WORKFLOW_DASHBOARD_LABELS.warning,
    ]) {
      expect(screen.queryByText(label)).toBeNull();
    }
  });

  it("warns about a completed lane whose merge conflicted, naming the files", () => {
    settleLane(WORKTREE_MERGE_OUTCOMES.CONFLICT, ["src/shared.ts"]);

    renderWorkflowRow(laneStep(), STEP_STATUS.COMPLETED, laneHarness);

    const badge = screen.getByText(SUB_WORKFLOW_DASHBOARD_LABELS.mergeConflict);
    expect(badge).toHaveAttribute(
      "title",
      expect.stringContaining(SUB_WORKFLOW_DASHBOARD_LABELS.mergeConflictReason)
    );
    expect(badge).toHaveAttribute(
      "title",
      expect.stringContaining("src/shared.ts")
    );
  });

  it("warns about a completed lane whose merge was blocked", () => {
    settleLane(WORKTREE_MERGE_OUTCOMES.BLOCKED);

    renderWorkflowRow(laneStep(), STEP_STATUS.COMPLETED, laneHarness);

    expect(
      screen.getByText(SUB_WORKFLOW_DASHBOARD_LABELS.mergeBlocked)
    ).toHaveAttribute(
      "title",
      SUB_WORKFLOW_DASHBOARD_LABELS.mergeBlockedReason
    );
  });

  it("uses the latest settlement of a continued lane", () => {
    settleLane(WORKTREE_MERGE_OUTCOMES.BLOCKED);
    useWorkflowStore.setState((state) => ({
      liveOrderedEntries: [
        ...state.liveOrderedEntries,
        {
          kind: OUTPUT_HISTORY_KINDS.SUB_WORKFLOW,
          target: { kind: "queue", stepIndex: 0 },
          timestampMs: 20,
          sequence: 7,
          subWorkflowOutput: {
            childWorkflowKey: "lane-key",
            childRunRef: "lane-run",
            outcome: { status: "completed" },
            worktree: {
              mode: WORKTREE_MODES.MANAGED,
              branchName: "ctrlyoke/lane/run-1",
              baseCommit: "base",
              mergeOutcome: WORKTREE_MERGE_OUTCOMES.MERGE_COMMIT,
            },
          },
        },
      ] as never,
    }));

    renderWorkflowRow(laneStep(), STEP_STATUS.COMPLETED);

    expect(
      screen.queryByText(SUB_WORKFLOW_DASHBOARD_LABELS.mergeBlocked)
    ).toBeNull();
  });

  it.each([STEP_STATUS.FAILED, STEP_STATUS.RUNNING])(
    "shows no merge badge on a %s lane, even with a conflicting settlement",
    (laneStatus) => {
      settleLane(WORKTREE_MERGE_OUTCOMES.CONFLICT, ["src/shared.ts"]);

      renderWorkflowRow(laneStep(), laneStatus, laneHarness);

      for (const label of [
        SUB_WORKFLOW_DASHBOARD_LABELS.mergeConflict,
        SUB_WORKFLOW_DASHBOARD_LABELS.mergeBlocked,
        SUB_WORKFLOW_DASHBOARD_LABELS.mergeAbortFailed,
      ]) {
        expect(screen.queryByText(label)).toBeNull();
      }
    }
  );

  function namedLaneStep(worktree: unknown, runtime: Record<string, unknown>) {
    return {
      type: STEP_TYPES.WORKFLOW,
      workflow: { prompt: lanePrompt, worktree },
      _runtime: runtime,
    } as never;
  }

  it.each([
    ["object", { mode: WORKTREE_MODES.NAMED, branch: "docs/refresh" }],
    ["shorthand", "docs/refresh"],
  ])(
    "names a %s named worktree's branch before its child starts",
    (_form, worktree) => {
      renderWorkflowRow(namedLaneStep(worktree, {}), STEP_STATUS.PENDING);

      const badge = screen.getByTestId("workflow-step-worktree-badge");
      expect(badge).toHaveTextContent("docs/refresh");
      expect(badge).toHaveAttribute(
        "title",
        expect.stringContaining("docs/refresh")
      );
    }
  );

  it("prefers the running child's branch over the definition's", () => {
    useUiStore.setState({
      loadedWorkflows: [
        {
          id: "lane-instance",
          workflowKey: "lane-key",
          workflowName: "Lane",
          filePath: "",
          executionState: EXECUTION_STATES.RUNNING,
          worktree: { branchName: "docs/refresh-2", worktreePath: "/w" },
        },
      ] as never,
    });

    renderWorkflowRow(
      namedLaneStep(
        { mode: WORKTREE_MODES.NAMED, branch: "docs/refresh" },
        { childWorkflowKey: "lane-key", childRunRef: "lane-run" }
      ),
      STEP_STATUS.RUNNING
    );

    expect(
      screen.getByTestId("workflow-step-worktree-badge")
    ).toHaveTextContent("docs/refresh-2");
  });

  it("collapses the worktree badge before the lane's title gives up room", () => {
    renderWorkflowRow(laneStep(), STEP_STATUS.PENDING, laneHarness);

    // jsdom does no layout, so this pins the contract the layout relies on:
    // the badge out-shrinks the title, stops at its icon box, and keeps the
    // branch reachable in its tooltip.
    const badge = screen.getByTestId("workflow-step-worktree-badge");
    expect(badge).toHaveClass("shrink-1000", "min-w-6", "overflow-hidden");
    expect(badge.firstElementChild).toHaveClass("w-4", "shrink-0");
    expect(badge.lastElementChild).toHaveClass("min-w-0", "truncate");
    const title = screen.getByText(lanePrompt, {
      selector: "span.truncate",
    });
    expect(title).not.toHaveClass("shrink-0");
    expect(title.className).not.toMatch(/shrink-\d/);
  });

  it("keeps a file reference without a worktree badge or harness line", () => {
    renderWorkflowRow(step, STEP_STATUS.RUNNING);

    expect(screen.queryByTestId("workflow-step-worktree-badge")).toBeNull();
    expect(
      screen.getByText("workflows/verify.ctrlyoke.yaml")
    ).toBeInTheDocument();
    expect(
      screen.getAllByText(SUB_WORKFLOW_DASHBOARD_LABELS.workflow)
    ).toHaveLength(2);
  });
});
