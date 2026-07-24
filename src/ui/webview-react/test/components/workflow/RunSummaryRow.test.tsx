/**
 * Tests for RunSummaryRow — the run panel's draft/run row.
 *
 * Covers the metadata the row must show at a normal dropdown width (it
 * previously collapsed to a bare run number because the compact layout was
 * driven by the split button's width rather than the dropdown's) and the
 * colour-carrying state badge in the compact layout.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { RunSummaryRow } from "@components/workflow/RunSummaryRow";
import { EXECUTION_STATES, HARNESS_IDS } from "@/types/messages";
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
} as unknown as RunSummary;

function renderRow(isNarrow: boolean) {
  return render(
    <RunSummaryRow
      row={{ kind: "run", summary }}
      rowKey="run:wf:run-14"
      isViewed={false}
      isPending={false}
      isLive={false}
      isNarrow={isNarrow}
      canDelete
      onSelect={vi.fn()}
      onDelete={vi.fn()}
    />
  );
}

describe("RunSummaryRow", () => {
  it("shows run number, step count, state, and time at full width", () => {
    renderRow(false);
    expect(screen.getByText("Run 14")).toBeInTheDocument();
    expect(screen.getByText("4 steps")).toBeInTheDocument();
    expect(screen.getByText(EXECUTION_STATES.COMPLETED)).toBeInTheDocument();
    expect(screen.getByText(/minutes ago|minute ago/)).toBeInTheDocument();
  });

  it("stacks onto two lines in a narrow dropdown without abbreviating", () => {
    const { container } = renderRow(true);
    expect(
      container.querySelector(".workflow-row-primary-stacked")
    ).not.toBeNull();
    // The stacked layout has room for full text — no `#14` / icon-only badge.
    expect(screen.getByText("Run 14")).toBeInTheDocument();
    expect(screen.getByText("4 steps")).toBeInTheDocument();
    expect(screen.getByText(EXECUTION_STATES.COMPLETED)).toBeInTheDocument();
    expect(
      container.querySelector(".workflow-row-cell-meta")?.textContent
    ).toMatch(/4 steps.*·.*ago/);
  });

  it("uses the flat single-line layout when the dropdown is wide", () => {
    const { container } = renderRow(false);
    expect(
      container.querySelector(".workflow-row-primary-flat")
    ).not.toBeNull();
    expect(container.querySelector(".workflow-row-primary-stacked")).toBeNull();
  });

  it("exposes the full identity in the accessible name regardless of width", () => {
    renderRow(true);
    expect(
      screen.getByRole("button", { name: /Run 14 — completed/i })
    ).toBeInTheDocument();
  });
});
