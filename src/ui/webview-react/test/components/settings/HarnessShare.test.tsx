import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { StatsUsageSection } from "@components/settings/stats/StatsUsageSection";
import { useWorkspaceStatsStore } from "@store/workspaceStatsStore";
import {
  HARNESS_IDS,
  RUN_OUTCOME_BUCKETS,
  WORKSPACE_STATS_BACKFILL_STATES,
} from "@root/types/DashboardConstants";
import type { HarnessId } from "@root/types/DashboardConstants";
import type {
  LifetimeHarnessContribution,
  WorkspaceStatsSnapshot,
} from "@root/types/UsageTypes";

function contribution(
  attemptCount: number,
  total: number,
  costUsd = 12
): LifetimeHarnessContribution {
  return {
    input: total / 2,
    output: total / 2,
    total,
    costUsd,
    attemptCount,
    reportedAttemptCount: attemptCount,
  };
}

function snapshot(
  byHarness: Partial<Record<HarnessId, LifetimeHarnessContribution>>
): WorkspaceStatsSnapshot {
  const totals = Object.values(byHarness).reduce<LifetimeHarnessContribution>(
    (result, value) => ({
      input: result.input + (value?.input ?? 0),
      output: result.output + (value?.output ?? 0),
      total: result.total + (value?.total ?? 0),
      costUsd: (result.costUsd ?? 0) + (value?.costUsd ?? 0),
      attemptCount: result.attemptCount + (value?.attemptCount ?? 0),
      reportedAttemptCount:
        result.reportedAttemptCount + (value?.reportedAttemptCount ?? 0),
    }),
    {
      input: 0,
      output: 0,
      total: 0,
      costUsd: 0,
      attemptCount: 0,
      reportedAttemptCount: 0,
    }
  );

  return {
    updatedAt: 1,
    workflowCount: 1,
    runCount: 1,
    outcomes: {
      [RUN_OUTCOME_BUCKETS.COMPLETED]: 1,
      [RUN_OUTCOME_BUCKETS.STOPPED]: 0,
      [RUN_OUTCOME_BUCKETS.ERROR]: 0,
    },
    totalActiveExecutionMs: 0,
    wallClockDurationRunCount: 0,
    skippedRunCount: 0,
    totals,
    byHarness,
    backfill: {
      state: WORKSPACE_STATS_BACKFILL_STATES.COMPLETE,
      scanned: 0,
      total: 0,
    },
  };
}

function getShareSection(): HTMLElement {
  return screen
    .getByRole("heading", { name: "Harness share" })
    .closest("section") as HTMLElement;
}

describe("Harness share", () => {
  beforeEach(() => {
    useWorkspaceStatsStore.setState({ snapshot: undefined });
  });

  it("ranks the same harnesses differently by AI steps and tokens", async () => {
    useWorkspaceStatsStore.setState({
      snapshot: snapshot({
        [HARNESS_IDS.CLAUDE_CLI]: contribution(10, 100),
        [HARNESS_IDS.CODEX_CLI]: contribution(4, 1_000),
      }),
    });

    const user = userEvent.setup();
    render(<StatsUsageSection hideCost={false} />);
    const share = getShareSection();

    expect(share.querySelector('[aria-label^="Claude Code,"]')).toBeTruthy();
    expect(
      share
        .querySelector('[aria-label^="Claude Code,"]')!
        .compareDocumentPosition(
          share.querySelector('[aria-label^="Codex,"]')!
        ) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "By tokens" }));

    expect(
      share
        .querySelector('[aria-label^="Codex,"]')!
        .compareDocumentPosition(
          share.querySelector('[aria-label^="Claude Code,"]')!
        ) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("keeps the bar decorative while exposing values in row text", () => {
    useWorkspaceStatsStore.setState({
      snapshot: snapshot({
        [HARNESS_IDS.CLAUDE_CLI]: contribution(10, 41_200_000, 38.2),
      }),
    });

    render(<StatsUsageSection hideCost={false} />);
    const share = getShareSection();
    const bar = share.querySelector('[aria-hidden="true"]');

    expect(bar).toBeInTheDocument();
    expect(bar?.querySelector('[title*="Claude Code"]')).toBeInTheDocument();
    expect(
      within(share).getByText(/10 steps · 41.2M tokens · ≈\$38.20/)
    ).toBeInTheDocument();
  });

  it("collapses zero-usage harnesses into one muted line", () => {
    useWorkspaceStatsStore.setState({
      snapshot: snapshot({
        [HARNESS_IDS.CLAUDE_CLI]: contribution(10, 100),
      }),
    });

    render(<StatsUsageSection hideCost={false} />);
    const share = getShareSection();

    expect(
      within(share).getByText(
        "Unused: Copilot CLI, Codex, OpenCode, Qwen Code, Antigravity CLI"
      )
    ).toBeInTheDocument();
    expect(
      share.querySelector('[aria-hidden="true"]')?.querySelectorAll("[title]")
        .length
    ).toBe(1);
  });

  it("handles an empty workspace without NaN or zero-width segments", () => {
    useWorkspaceStatsStore.setState({ snapshot: snapshot({}) });

    render(<StatsUsageSection hideCost={false} />);
    const share = getShareSection();

    expect(
      within(share).getByText("No AI steps recorded yet.")
    ).toBeInTheDocument();
    expect(share.querySelector('[aria-hidden="true"] [title]')).toBeNull();
    expect(share.textContent).not.toContain("NaN");
  });

  it("omits row costs when hideCost is enabled", () => {
    useWorkspaceStatsStore.setState({
      snapshot: snapshot({
        [HARNESS_IDS.CLAUDE_CLI]: contribution(10, 100, 38.2),
      }),
    });

    render(<StatsUsageSection hideCost={true} />);

    expect(screen.queryByText("≈$38.20")).not.toBeInTheDocument();
    expect(screen.getByText("10 steps · 100 tokens")).toBeInTheDocument();
  });
});
