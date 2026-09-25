import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatTileGrid } from "@components/settings/stats/StatTileGrid";
import {
  RUN_OUTCOME_BUCKETS,
  WORKSPACE_STATS_BACKFILL_STATES,
} from "@root/types/DashboardConstants";
import type { WorkspaceStatsSnapshot } from "@root/types/UsageTypes";

function snapshot(): WorkspaceStatsSnapshot {
  return {
    updatedAt: 1,
    workflowCount: 12,
    runCount: 8,
    outcomes: {
      [RUN_OUTCOME_BUCKETS.COMPLETED]: 5,
      [RUN_OUTCOME_BUCKETS.STOPPED]: 2,
      [RUN_OUTCOME_BUCKETS.ERROR]: 1,
    },
    totalActiveExecutionMs: 3_725_000,
    wallClockDurationRunCount: 2,
    skippedRunCount: 3,
    totals: {
      input: 4_000,
      output: 8_345,
      total: 12_345,
      costUsd: 4.5,
      costSources: ["price-table"],
      costPartial: false,
      partial: true,
      attemptCount: 27,
      reportedAttemptCount: 26,
    },
    byHarness: {},
    backfill: {
      state: WORKSPACE_STATS_BACKFILL_STATES.RUNNING,
      scanned: 340,
      total: 1200,
    },
  };
}

describe("StatTileGrid", () => {
  it("renders partial totals and every required disclosure", () => {
    render(
      <StatTileGrid snapshot={snapshot()} isNarrow={false} showCostEstimates={true} />
    );

    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.getByText("27")).toBeInTheDocument();
    expect(screen.getByText("≥12.3k")).toBeInTheDocument();
    expect(screen.getByText("≈$4.50")).toBeInTheDocument();
    expect(screen.getByText("at API list prices")).toBeInTheDocument();
    expect(
      screen.getByText(/Includes 2 runs measured as wall clock/)
    ).toBeInTheDocument();
    expect(screen.getByText(/3 runs skipped/)).toBeInTheDocument();
    expect(screen.getByText("Building history… 340/1,200")).toBeInTheDocument();
    expect(
      screen.getByText("Current totals are partial and still building.")
    ).toBeInTheDocument();
    expect(
      screen.getByText(/5 completed · 2 stopped · 1 error/)
    ).toBeInTheDocument();
  });

  it("suppresses the cost tile when showCostEstimates is disabled", () => {
    render(
      <StatTileGrid snapshot={snapshot()} isNarrow={true} showCostEstimates={false} />
    );

    expect(screen.queryByText("Estimated cost")).not.toBeInTheDocument();
    expect(screen.getByText("Total tokens")).toBeInTheDocument();
  });
});
