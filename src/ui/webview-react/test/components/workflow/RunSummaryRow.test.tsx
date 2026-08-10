/**
 * Tests for RunSummaryRow — the run panel's draft/run row.
 *
 * Covers the metadata the row must show at a normal dropdown width (it
 * previously collapsed to a bare run number because the compact layout was
 * driven by the split button's width rather than the dropdown's) and what each
 * tier is and isn't allowed to abbreviate.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { RunSummaryRow } from "@components/workflow/RunSummaryRow";
import type { WorkflowRowTier } from "@/constants";
import { EXECUTION_STATES, HARNESS_IDS } from "@/types/messages";
import { ATTEMPT_COST_SOURCES } from "@root/types/DashboardConstants";
import type { RunSummary } from "@root/types/WorkflowTimelineTypes";

const summary = {
  workflowKey: "wf" as never,
  runRef: "run-14" as never,
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
      row={{ kind: "run", summary }}
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
  it("shows run number, step count, state, and time at full width", () => {
    renderRow("flat");
    expect(screen.getByText("Run 14")).toBeInTheDocument();
    expect(screen.getByText("4 steps")).toBeInTheDocument();
    expect(screen.getByText(EXECUTION_STATES.COMPLETED)).toBeInTheDocument();
    expect(screen.getByText(/minutes ago|minute ago/)).toBeInTheDocument();
    expect(screen.getByTestId("workflow-token-usage")).toHaveTextContent(
      "410k"
    );
  });

  it("stacks onto two lines in a narrow dropdown without abbreviating", () => {
    const { container } = renderRow("stacked");
    expect(
      container.querySelector(".workflow-row-primary-stacked")
    ).not.toBeNull();
    // Stacking alone bought the label its own line — full text everywhere.
    expect(screen.getByText("Run 14")).toBeInTheDocument();
    expect(screen.getByText("4 steps")).toBeInTheDocument();
    expect(screen.getByText(EXECUTION_STATES.COMPLETED)).toBeInTheDocument();
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

  it("uses the flat single-line layout when the dropdown is wide", () => {
    const { container } = renderRow("flat");
    expect(
      container.querySelector(".workflow-row-primary-flat")
    ).not.toBeNull();
    expect(container.querySelector(".workflow-row-primary-stacked")).toBeNull();
  });

  it("shows a lower-bound run cost when one attempt was unpriceable", () => {
    render(
      <RunSummaryRow
        row={{
          kind: "run",
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
        tier="flat"
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
});
