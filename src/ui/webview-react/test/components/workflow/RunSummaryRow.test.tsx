/**
 * Tests for RunSummaryRow — the run panel's draft/run row.
 *
 * Covers the metadata the row must show at a normal dropdown width (it
 * previously collapsed to a bare run number because the compact layout was
 * driven by the split button's width rather than the dropdown's) and what each
 * tier is and isn't allowed to abbreviate.
 */
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { RunSummaryRow } from "@components/workflow/RunSummaryRow";
import type { WorkflowRowTier } from "@/constants";
import { EXECUTION_STATES, HARNESS_IDS } from "@/types/messages";
import {
  ATTEMPT_COST_SOURCES,
  WORKFLOW_VIEW_ADDRESS_KIND,
} from "@root/types/DashboardConstants";
import type { RunSummary } from "@root/types/WorkflowTimelineTypes";

const summary = {
  workflowKey: "wf" as never,
  runRef: "run-14" as never,
  runDirectory: "/runs/wf/run-14",
  runId: 14,
  startedAt: Date.now() - 5 * 60 * 1000,
  completedAt: Date.now() - 5 * 60 * 1000,
  executionState: EXECUTION_STATES.COMPLETED,
  definitionRevision: 1,
  stepCount: 4,
  primaryHarness: HARNESS_IDS.CLAUDE_CLI,
  hasMixedHarnesses: false,
  hasMixedModels: false,
  tokenTotals: {
    total: 410_000,
    coverage: "complete",
    reportedAttemptCount: 1,
    attemptCount: 1,
    isFinal: true,
    byHarness: {},
    byLocalDay: {},
  },
} as unknown as RunSummary;

function renderRow(tier: WorkflowRowTier) {
  return render(
    <RunSummaryRow
      row={{ kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN, summary }}
      rowKey="run:wf:run-14"
      isViewed={false}
      isPending={false}
      isLive={false}
      tier={tier}
      canDelete
      onSelect={vi.fn()}
      onDelete={vi.fn()}
    />
  );
}

describe("RunSummaryRow", () => {
  it("shows run number, step count, state, and time, full text throughout", () => {
    const { container } = renderRow("stacked");
    expect(
      container.querySelector(".workflow-row-primary-stacked")
    ).not.toBeNull();
    expect(screen.getByText("Run 14")).toBeInTheDocument();
    expect(screen.getByText("4 steps")).toBeInTheDocument();
    expect(screen.getByText(EXECUTION_STATES.COMPLETED)).toBeInTheDocument();
    expect(screen.getByText(/minutes ago|minute ago/)).toBeInTheDocument();
    expect(screen.getByTestId("workflow-token-usage")).toHaveTextContent(
      "410k"
    );
    expect(
      container.querySelector(".workflow-row-cell-meta")?.textContent
    ).toMatch(/4 steps.*·.*ago/);
  });

  // The badge is the widest fixed item on the stacked first line; at a
  // phone-width popup its ~75px of text is what squeezed the run label down
  // to a couple of characters.
  it("drops the state badge to its icon at the compact tier, keeping everything else", () => {
    const { container } = renderRow("compact");
    expect(screen.queryByText(EXECUTION_STATES.COMPLETED)).toBeNull();
    expect(
      container.querySelector(
        `[title="${EXECUTION_STATES.COMPLETED}"] .codicon`
      )
    ).not.toBeNull();
    expect(screen.getByText("Run 14")).toBeInTheDocument();
    expect(screen.getByText("4 steps")).toBeInTheDocument();
    expect(screen.queryByTestId("workflow-token-usage")).toBeNull();
  });

  it("shows a lower-bound run cost when one attempt was unpriceable", () => {
    render(
      <RunSummaryRow
        row={{
          kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
          summary: {
            ...summary,
            tokenTotals: {
              ...summary.tokenTotals,
              costUsd: 0.41,
              costPartial: true,
              costSources: [ATTEMPT_COST_SOURCES.PRICE_TABLE],
            },
          } as RunSummary,
        }}
        rowKey="run:wf:run-14-partial"
        isViewed={false}
        isPending={false}
        isLive={false}
        tier="stacked"
        canDelete
        onSelect={vi.fn()}
        onDelete={vi.fn()}
      />
    );

    expect(screen.getByTestId("workflow-token-usage")).toHaveTextContent(
      "≥$0.41"
    );
  });

  it("exposes the full identity in the accessible name regardless of width", () => {
    renderRow("compact");
    expect(
      screen.getByRole("button", { name: /Run 14 — completed/i })
    ).toBeInTheDocument();
  });

  it("opens a run-scoped target with the row's own directory", () => {
    const onOpenContextMenu = vi.fn();
    const { container } = render(
      <RunSummaryRow
        row={{ kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN, summary }}
        rowKey="run:wf:run-14"
        isViewed={false}
        isPending={false}
        isLive={false}
        canDelete
        contextMenuAddress={{
          workflowKey: "wf" as never,
          kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
          runRef: "run-14" as never,
        }}
        workflowName="Workflow"
        isFavorite
        onOpenContextMenu={onOpenContextMenu}
        onSelect={vi.fn()}
      />
    );

    fireEvent.contextMenu(container.querySelector(".run-panel-row")!, {
      clientX: 10,
      clientY: 20,
    });

    expect(onOpenContextMenu).toHaveBeenCalledWith(
      10,
      20,
      expect.objectContaining({
        address: {
          workflowKey: "wf",
          kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
          runRef: "run-14",
        },
        scope: "run",
        workflowName: "Workflow",
        isFavorite: true,
        runDirectory: "/runs/wf/run-14",
        isExecuting: false,
      }),
      expect.any(HTMLButtonElement)
    );
  });

  it("uses the dedicated draft directory for the draft row", () => {
    const onOpenContextMenu = vi.fn();
    const { container } = render(
      <RunSummaryRow
        row={{ kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT }}
        rowKey="draft:wf"
        isViewed={false}
        isPending={false}
        isLive={false}
        canDelete={false}
        contextMenuAddress={{
          workflowKey: "wf" as never,
          kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
        }}
        draftDirectory="/runs/wf/draft"
        onOpenContextMenu={onOpenContextMenu}
        onSelect={vi.fn()}
      />
    );

    fireEvent.contextMenu(container.querySelector(".run-panel-row")!, {
      clientX: 10,
      clientY: 20,
    });

    expect(onOpenContextMenu).toHaveBeenCalledWith(
      10,
      20,
      expect.objectContaining({
        address: { workflowKey: "wf", kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT },
        runDirectory: "/runs/wf/draft",
        isExecuting: false,
      }),
      expect.any(HTMLButtonElement)
    );
  });

  it("does not fall back to the draft directory for a run without one", () => {
    const onOpenContextMenu = vi.fn();
    const { container } = render(
      <RunSummaryRow
        row={{
          kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
          summary: {
            ...summary,
            runDirectory: undefined,
          } as unknown as RunSummary,
        }}
        rowKey="run:wf:run-14"
        isViewed={false}
        isPending={false}
        isLive={false}
        canDelete
        contextMenuAddress={{
          workflowKey: "wf" as never,
          kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
          runRef: "run-14" as never,
        }}
        draftDirectory="/runs/wf/draft"
        onOpenContextMenu={onOpenContextMenu}
        onSelect={vi.fn()}
      />
    );

    fireEvent.contextMenu(container.querySelector(".run-panel-row")!, {
      clientX: 10,
      clientY: 20,
    });

    expect(onOpenContextMenu.mock.calls[0][2]).toEqual(
      expect.objectContaining({ runDirectory: undefined })
    );
  });

  it("shows the run's own worktree branch, distinct from other runs of the same lineage", () => {
    const { container } = render(
      <RunSummaryRow
        row={{
          kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
          summary: {
            ...summary,
            worktree: {
              mode: "managed",
              branchName: "feature/auth",
              worktreePath: "C:/worktrees/feature-auth",
            },
          } as unknown as RunSummary,
        }}
        rowKey="run:wf:run-14"
        isViewed={false}
        isPending={false}
        isLive={false}
        tier="stacked"
        canDelete
        onSelect={vi.fn()}
        onDelete={vi.fn()}
      />
    );

    const branch = container.querySelector(".codicon-source-control")!;
    expect(branch).toHaveAttribute(
      "title",
      "Branch: feature/auth\nWorktree: C:/worktrees/feature-auth"
    );
  });

  it("uses the same target and opener for right-click and long-press", () => {
    vi.useFakeTimers();
    try {
      const onOpenContextMenu = vi.fn();
      const { container } = render(
        <RunSummaryRow
          row={{ kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN, summary }}
          rowKey="run:wf:run-14"
          isViewed={false}
          isPending={false}
          isLive={false}
          canDelete
          contextMenuAddress={{
            workflowKey: "wf" as never,
            kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
            runRef: "run-14" as never,
          }}
          onOpenContextMenu={onOpenContextMenu}
          onSelect={vi.fn()}
        />
      );
      const row = container.querySelector(".run-panel-row")!;
      fireEvent.touchStart(row, {
        touches: [{ clientX: 10, clientY: 20 }],
      });
      vi.advanceTimersByTime(500);
      fireEvent.contextMenu(row, { clientX: 10, clientY: 20 });

      expect(onOpenContextMenu).toHaveBeenCalledTimes(2);
      expect(onOpenContextMenu.mock.calls[0][2]).toEqual(
        onOpenContextMenu.mock.calls[1][2]
      );
      expect(onOpenContextMenu.mock.calls[0][3]).toBe(
        onOpenContextMenu.mock.calls[1][3]
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
