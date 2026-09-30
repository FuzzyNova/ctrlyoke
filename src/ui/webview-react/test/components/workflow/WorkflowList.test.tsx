import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import {
  WorkflowList,
  type UnifiedWorkflowRow,
} from "@components/workflow/WorkflowList";
import { EXECUTION_STATES, HARNESS_IDS } from "@/types/messages";
import type { WorkflowTokenTotals } from "@root/types/CtrlYokeTypes";
import {
  WORKFLOW_ROW_KINDS,
  WORKFLOW_ROW_TIERS,
  type WorkflowRowTier,
} from "@/constants";
import { WORKFLOW_VIEW_ADDRESS_KIND } from "@root/types/DashboardConstants";

const totalsBase: WorkflowTokenTotals = {
  total: 410_000,
  coverage: "complete",
  reportedAttemptCount: 1,
  attemptCount: 1,
  isFinal: true,
  byHarness: {},
  byLocalDay: {},
};

function makeTotals(
  variant: "complete" | "partial" | "running"
): WorkflowTokenTotals {
  return {
    ...totalsBase,
    coverage: variant === "partial" ? "partial" : "complete",
    isFinal: variant !== "running",
  };
}

function renderWorkflowList(
  tier: WorkflowRowTier,
  kind: (typeof WORKFLOW_ROW_KINDS)[keyof typeof WORKFLOW_ROW_KINDS],
  totals?: WorkflowTokenTotals
) {
  const row: UnifiedWorkflowRow =
    kind === WORKFLOW_ROW_KINDS.RECENT
      ? {
          kind,
          key: "recent:wf",
          workflow: {
            address: {
              workflowKey: "wf" as never,
              kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
              runRef: "run-1" as never,
            },
            workflowName: "Token workflow",
            executionState: EXECUTION_STATES.COMPLETED,
            totalSteps: 2,
            harness: HARNESS_IDS.CLAUDE_CLI,
            tokenTotals: totals,
          },
        }
      : {
          kind,
          key: "running:wf",
          workflow: {
            id: "workflow-id",
            workflowName: "Token workflow",
            filePath: "workflow.prompt.md",
            executionState: EXECUTION_STATES.RUNNING,
            currentStep: 1,
            totalSteps: 2,
            harness: HARNESS_IDS.CLAUDE_CLI,
            tokenTotals: totals,
          },
        };

  return render(
    <WorkflowList
      rows={[row]}
      currentAddress={null}
      activeWorkflowId={
        kind === WORKFLOW_ROW_KINDS.RUNNING ? "workflow-id" : null
      }
      runningHasActiveTerminal={() => false}
      onSelectRecent={() => undefined}
      onSwitchRunning={() => undefined}
      onPauseRunning={() => undefined}
      onCancelPauseRunning={() => undefined}
      onResumeRunning={() => undefined}
      onStopRunning={() => undefined}
      tier={tier}
    />
  );
}

describe("WorkflowList token totals", () => {
  afterEach(() => cleanup());

  it.each([WORKFLOW_ROW_TIERS.STACKED, WORKFLOW_ROW_TIERS.COMPACT] as const)(
    "renders complete totals and the full accessible phrase at the %s tier",
    (tier) => {
      renderWorkflowList(
        tier,
        WORKFLOW_ROW_KINDS.RECENT,
        makeTotals("complete")
      );

      expect(
        screen.getByRole("button", { name: /410,000 total tokens/ })
      ).toBeInTheDocument();
      if (tier === WORKFLOW_ROW_TIERS.COMPACT) {
        expect(screen.queryByTestId("workflow-token-usage")).toBeNull();
      } else {
        expect(screen.getByTestId("workflow-token-usage")).toHaveTextContent(
          "410k"
        );
      }
    }
  );

  it.each([WORKFLOW_ROW_TIERS.STACKED, WORKFLOW_ROW_TIERS.COMPACT] as const)(
    "renders partial totals as lower bounds at the %s tier",
    (tier) => {
      renderWorkflowList(
        tier,
        WORKFLOW_ROW_KINDS.RECENT,
        makeTotals("partial")
      );

      expect(
        screen.getByRole("button", { name: /at least 410,000 observed tokens/ })
      ).toBeInTheDocument();
      if (tier !== WORKFLOW_ROW_TIERS.COMPACT) {
        expect(screen.getByTestId("workflow-token-usage")).toHaveTextContent(
          "≥410k"
        );
      }
    }
  );

  it.each([WORKFLOW_ROW_TIERS.STACKED, WORKFLOW_ROW_TIERS.COMPACT] as const)(
    "shows the live observed-so-far total at the %s tier",
    (tier) => {
      renderWorkflowList(
        tier,
        WORKFLOW_ROW_KINDS.RUNNING,
        makeTotals("running")
      );

      const usage = screen.queryByTestId("workflow-token-usage");
      expect(
        screen.getByRole("button", { name: /410,000 total tokens/ })
      ).toBeInTheDocument();
      if (tier === WORKFLOW_ROW_TIERS.COMPACT) {
        expect(usage).toBeNull();
      } else {
        expect(usage).toHaveAttribute(
          "title",
          expect.stringContaining("still increasing")
        );
      }
    }
  );

  it.each([WORKFLOW_ROW_TIERS.STACKED, WORKFLOW_ROW_TIERS.COMPACT] as const)(
    "renders no usage slot for unavailable totals at the %s tier",
    (tier) => {
      renderWorkflowList(tier, WORKFLOW_ROW_KINDS.RECENT);

      expect(screen.queryByTestId("workflow-token-usage")).toBeNull();
      expect(
        screen.getByRole("button", { name: /Token workflow/ })
      ).not.toHaveAttribute("aria-label", expect.stringMatching(/tokens/));
    }
  );
});

describe("WorkflowList row action scoping", () => {
  afterEach(() => cleanup());

  it("resolves repeated actions from the workflow row name", () => {
    const onToggleFavorite = vi.fn();
    const onRemove = vi.fn();
    const makeRecentRow = (
      key: string,
      workflowName: string
    ): UnifiedWorkflowRow => ({
      kind: WORKFLOW_ROW_KINDS.RECENT,
      key,
      workflow: {
        address: {
          workflowKey: key as never,
          kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
        },
        workflowName,
        executionState: EXECUTION_STATES.COMPLETED,
        isFavorite: false,
      },
    });

    render(
      <WorkflowList
        rows={[
          makeRecentRow("workflow-a", "Workflow A"),
          makeRecentRow("workflow-b", "Workflow B"),
        ]}
        currentAddress={null}
        activeWorkflowId={null}
        runningHasActiveTerminal={() => false}
        onSelectRecent={() => undefined}
        onSwitchRunning={() => undefined}
        onPauseRunning={() => undefined}
        onCancelPauseRunning={() => undefined}
        onResumeRunning={() => undefined}
        onStopRunning={() => undefined}
        onToggleFavorite={onToggleFavorite}
        onRemove={onRemove}
      />
    );

    const workflowRow = screen.getByRole("listitem", {
      name: /Workflow A/,
    });
    const favoriteButton = within(workflowRow).getByRole("button", {
      name: "Add to favorites",
    });
    const removeButton = within(workflowRow).getByRole("button", {
      name: "Remove from history",
    });

    expect(favoriteButton).toBeInTheDocument();
    expect(removeButton).toBeInTheDocument();

    fireEvent.click(favoriteButton);
    fireEvent.click(removeButton);

    expect(onToggleFavorite).toHaveBeenCalledWith({
      workflowKey: "workflow-a",
      kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
    });
    expect(onRemove).toHaveBeenCalledWith({
      workflowKey: "workflow-a",
      kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
    });
  });
});

describe("WorkflowList recent row worktree", () => {
  afterEach(() => cleanup());

  it("shows the branch icon for a completed lineage read from disk history", () => {
    render(
      <WorkflowList
        rows={[
          {
            kind: WORKFLOW_ROW_KINDS.RECENT,
            key: "recent:wf",
            workflow: {
              address: {
                workflowKey: "wf" as never,
                kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
                runRef: "run-1" as never,
              },
              workflowName: "Worktree workflow",
              executionState: EXECUTION_STATES.STOPPED,
              totalSteps: 2,
              worktree: {
                branchName: "feature/auth",
                worktreePath: "C:/worktrees/feature-auth",
              },
            },
          },
        ]}
        currentAddress={null}
        activeWorkflowId={null}
        runningHasActiveTerminal={() => false}
        onSelectRecent={() => undefined}
        onSwitchRunning={() => undefined}
        onPauseRunning={() => undefined}
        onCancelPauseRunning={() => undefined}
        onResumeRunning={() => undefined}
        onStopRunning={() => undefined}
      />
    );

    const branch = document.querySelector(".codicon-source-control")!;
    expect(branch).toHaveAttribute(
      "title",
      "Branch: feature/auth\nWorktree: C:/worktrees/feature-auth"
    );
  });
});

describe("WorkflowList context targets", () => {
  afterEach(() => cleanup());

  it("builds a lineage target from a recent row", () => {
    const onOpenContextMenu = vi.fn();
    render(
      <WorkflowList
        rows={[
          {
            kind: WORKFLOW_ROW_KINDS.RECENT,
            key: "recent:wf",
            workflow: {
              address: {
                workflowKey: "wf" as never,
                kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
              },
              workflowName: "Workflow",
              executionState: EXECUTION_STATES.COMPLETED,
              isFavorite: true,
              runDirectory: "/runs/wf/draft",
            },
          },
        ]}
        currentAddress={null}
        activeWorkflowId={null}
        runningHasActiveTerminal={() => false}
        onSelectRecent={() => undefined}
        onSwitchRunning={() => undefined}
        onPauseRunning={() => undefined}
        onCancelPauseRunning={() => undefined}
        onResumeRunning={() => undefined}
        onStopRunning={() => undefined}
        onOpenContextMenu={onOpenContextMenu}
      />
    );

    fireEvent.contextMenu(document.querySelector(".workflow-menu-item")!, {
      clientX: 10,
      clientY: 20,
    });

    expect(onOpenContextMenu).toHaveBeenCalledWith(
      10,
      20,
      expect.objectContaining({
        scope: "lineage",
        isFavorite: true,
        runDirectory: "/runs/wf/draft",
        isExecuting: false,
      }),
      expect.any(HTMLButtonElement)
    );
  });
});
