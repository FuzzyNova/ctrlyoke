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
import { useUiStore } from "@/store/uiStore";

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
      // Usage has its own metadata line, so it shows at every tier.
      expect(screen.getByTestId("workflow-token-usage")).toHaveTextContent(
        "410k"
      );
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
      expect(screen.getByTestId("workflow-token-usage")).toHaveTextContent(
        "≥410k"
      );
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
      expect(usage).toHaveAttribute(
        "title",
        expect.stringContaining("still increasing")
      );
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

describe("WorkflowList scheduled section", () => {
  afterEach(() => {
    cleanup();
    useUiStore.setState({ collapsedWorkflowListSections: [] });
  });

  const makeScheduled = (key: string, nextRunAt: number) => ({
    address: {
      workflowKey: key as never,
      kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
    } as const,
    workflowName: key,
    executionState: EXECUTION_STATES.IDLE,
    schedule: {
      enabled: true,
      trigger: { at: new Date(nextRunAt).toISOString() },
      hostId: "test-host",
    },
    scheduleNextRunAt: nextRunAt,
  });
  const baseProps = {
    rows: [] as UnifiedWorkflowRow[],
    currentAddress: null,
    activeWorkflowId: null,
    runningHasActiveTerminal: () => false,
    onSelectRecent: () => undefined,
    onSwitchRunning: () => undefined,
    onPauseRunning: () => undefined,
    onCancelPauseRunning: () => undefined,
    onResumeRunning: () => undefined,
    onStopRunning: () => undefined,
  };

  it("appears only when schedules exist and orders by next run", () => {
    const { rerender } = render(<WorkflowList {...baseProps} />);
    expect(
      screen.queryByRole("region", { name: "Scheduled workflows" })
    ).toBeNull();
    rerender(
      <WorkflowList
        {...baseProps}
        scheduledWorkflows={[
          makeScheduled("Later", Date.now() + 200_000),
          makeScheduled("Sooner", Date.now() + 100_000),
        ]}
      />
    );
    const section = screen.getByRole("region", { name: "Scheduled workflows" });
    const rows = within(section).getAllByRole("listitem");
    expect(rows[0]).toHaveAttribute(
      "aria-label",
      expect.stringContaining("Sooner")
    );
    expect(rows[1]).toHaveAttribute(
      "aria-label",
      expect.stringContaining("Later")
    );
  });

  it("gives a scheduled row the same rail as a history row", () => {
    render(
      <WorkflowList
        {...baseProps}
        scheduledWorkflows={[makeScheduled("Rail", Date.now() + 100_000)]}
        onToggleFavorite={vi.fn()}
        onRemove={vi.fn()}
      />
    );
    const row = within(
      screen.getByRole("region", { name: "Scheduled workflows" })
    ).getByRole("listitem");
    const buttons = within(row)
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label"));
    expect(buttons).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^Next run:/),
        "Add to favorites",
        "Remove from history",
      ])
    );
    expect(row.textContent).toMatch(/Next run:/);
  });

  it("sorts favourites first, then by next run", () => {
    render(
      <WorkflowList
        {...baseProps}
        scheduledWorkflows={[
          makeScheduled("Soon", Date.now() + 100_000),
          {
            ...makeScheduled("Starred", Date.now() + 900_000),
            isFavorite: true,
          },
        ]}
      />
    );
    const rows = within(
      screen.getByRole("region", { name: "Scheduled workflows" })
    ).getAllByRole("listitem");
    expect(rows[0]).toHaveAttribute(
      "aria-label",
      expect.stringContaining("Starred")
    );
  });

  it("collapses a pinned section to its caption and remembers it", () => {
    render(
      <WorkflowList
        {...baseProps}
        scheduledWorkflows={[makeScheduled("Folded", Date.now() + 100_000)]}
      />
    );
    const caption = screen.getByRole("button", { name: /Scheduled \(1\)/ });
    expect(caption).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(caption);
    expect(caption).toHaveAttribute("aria-expanded", "false");
    expect(useUiStore.getState().collapsedWorkflowListSections).toEqual([
      "scheduled",
    ]);
    expect(
      screen.queryByRole("listitem", { name: /Folded/ })
    ).not.toBeInTheDocument();
    fireEvent.click(caption);
    expect(
      screen.getByRole("listitem", { name: /Folded/ })
    ).toBeInTheDocument();
  });

  it("shares the height cap when both pinned sections are expanded", () => {
    const running: UnifiedWorkflowRow = {
      kind: WORKFLOW_ROW_KINDS.RUNNING,
      key: "running:wf",
      workflow: {
        id: "workflow-id",
        workflowName: "Runner",
        filePath: "workflow.ctrlyoke.json",
        executionState: EXECUTION_STATES.RUNNING,
        currentStep: 1,
        totalSteps: 2,
      },
    };
    const recent: UnifiedWorkflowRow = {
      kind: WORKFLOW_ROW_KINDS.RECENT,
      key: "recent:old",
      workflow: {
        ...makeScheduled("Old", 0),
        schedule: undefined,
        scheduleNextRunAt: undefined,
      },
    };
    render(
      <WorkflowList
        {...baseProps}
        rows={[running, recent]}
        scheduledWorkflows={[makeScheduled("Later", Date.now() + 100_000)]}
      />
    );
    const scheduledRegion = screen.getByRole("region", {
      name: "Scheduled workflows",
    });
    expect(scheduledRegion.className).toContain("max-h-[min(260px,30%)]");
    fireEvent.click(screen.getByRole("button", { name: /Running \(1\)/ }));
    expect(scheduledRegion.className).toContain("max-h-[min(260px,50%)]");
  });

  it("does not offer New Workflow beneath scheduled rows when history is empty", () => {
    render(
      <WorkflowList
        {...baseProps}
        scheduledWorkflows={[makeScheduled("Only", Date.now() + 100_000)]}
        onNewWorkflow={vi.fn()}
      />
    );
    expect(
      screen.queryByRole("button", { name: /New Workflow/ })
    ).not.toBeInTheDocument();
  });
});

describe("WorkflowList recent-history loading", () => {
  afterEach(() => cleanup());

  const runningRow: UnifiedWorkflowRow = {
    kind: WORKFLOW_ROW_KINDS.RUNNING,
    key: "running:wf",
    workflow: {
      id: "workflow-id",
      workflowName: "bug drain",
      filePath: "workflow.ctrlyoke.json",
      executionState: EXECUTION_STATES.RUNNING,
      currentStep: 2,
      totalSteps: 6,
    },
  };

  function renderList(rows: UnifiedWorkflowRow[], isLoadingRecent: boolean) {
    return render(
      <WorkflowList
        rows={rows}
        currentAddress={null}
        activeWorkflowId="workflow-id"
        runningHasActiveTerminal={() => false}
        onSelectRecent={() => undefined}
        onSwitchRunning={() => undefined}
        onPauseRunning={() => undefined}
        onCancelPauseRunning={() => undefined}
        onResumeRunning={() => undefined}
        onStopRunning={() => undefined}
        onNewWorkflow={() => undefined}
        isLoadingRecent={isLoadingRecent}
      />
    );
  }

  it("shows a loading row beneath running workflows until history arrives", () => {
    renderList([runningRow], true);

    expect(screen.getByText("Loading workflows…")).toHaveAttribute(
      "role",
      "status"
    );
    expect(
      screen.getByRole("region", { name: "Running workflows" })
    ).toBeInTheDocument();
  });

  it("shows loading instead of the New Workflow prompt before history arrives", () => {
    renderList([], true);

    expect(screen.getByText("Loading workflows…")).toHaveAttribute(
      "role",
      "status"
    );
    expect(screen.queryByRole("button", { name: /New Workflow/ })).toBeNull();
  });

  it("drops the loading row once history has loaded", () => {
    renderList([runningRow], false);

    expect(screen.queryByText("Loading workflows…")).toBeNull();
  });
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
    // The actions sit beside the metadata lines, outside the primary button,
    // so they never take width from the name line.
    expect(workflowRow).toHaveClass("workflow-row");
    for (const action of [favoriteButton, removeButton]) {
      expect(action.closest(".workflow-row-trailing")).not.toBeNull();
      expect(action.closest(".workflow-row-primary")).toBeNull();
    }

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

    const branch = document.querySelector(".codicon-worktree-compact")!;
    expect(branch).toHaveAttribute(
      "title",
      "Branch: feature/auth\nWorktree: C:/worktrees/feature-auth"
    );
  });

  it.each([WORKFLOW_ROW_TIERS.STACKED, WORKFLOW_ROW_TIERS.COMPACT] as const)(
    "shows a settled lineage's run time at the %s tier",
    (tier) => {
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
                workflowName: "Timed workflow",
                executionState: EXECUTION_STATES.COMPLETED,
                totalSteps: 3,
                lastModifiedAt: Date.now() - 14 * 60_000,
                activeExecutionMs: 531_000,
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
          tier={tier}
        />
      );

      expect(
        document.querySelector(".workflow-row-cell-meta-activity")?.textContent
      ).toMatch(/3 steps.*·.*14 minutes ago/);
      expect(
        document.querySelector(".workflow-row-cell-meta-usage")?.textContent
      ).toBe("8:51");
      expect(
        screen.getByRole("button", { name: /run time 8 minutes 51 seconds/ })
      ).toBeInTheDocument();
    }
  );
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
