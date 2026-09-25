import { describe, expect, it } from "vitest";
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
import {
  buildWorkspaceStatsExport,
  WORKSPACE_STATS_EXPORT_SCHEMA_VERSION,
} from "@utils/workspaceStatsExport";

function contribution(
  attemptCount: number,
  total: number,
  costUsd = 12.34
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
  byHarness: Partial<Record<HarnessId, LifetimeHarnessContribution>> = {
    [HARNESS_IDS.CLAUDE_CLI]: contribution(2_500, 1_500_000),
  }
): WorkspaceStatsSnapshot {
  return {
    updatedAt: Date.UTC(2026, 7, 11),
    workflowCount: 4,
    runCount: 7,
    outcomes: {
      [RUN_OUTCOME_BUCKETS.COMPLETED]: 5,
      [RUN_OUTCOME_BUCKETS.STOPPED]: 1,
      [RUN_OUTCOME_BUCKETS.ERROR]: 1,
    },
    totalActiveExecutionMs: 3_720_000,
    wallClockDurationRunCount: 2,
    skippedRunCount: 1,
    totals: contribution(2_500, 1_500_000),
    byHarness,
    backfill: {
      state: WORKSPACE_STATS_BACKFILL_STATES.COMPLETE,
      scanned: 7,
      total: 7,
    },
  };
}

describe("buildWorkspaceStatsExport", () => {
  it("produces a shareable Markdown summary with aggregate values", () => {
    const exported = buildWorkspaceStatsExport(snapshot(), {
      generatedAt: Date.UTC(2026, 7, 11, 12),
      showCostEstimates: true,
    });

    expect(exported.markdown).toContain("# ctrlyoke workspace statistics");
    expect(exported.markdown).toContain("Scope: workspace-local");
    expect(exported.markdown).toContain("Provenance: ctrlyoke-observed");
    expect(exported.markdown).toContain("| AI steps | 2.5k |");
    expect(exported.markdown).toContain("| Total tokens | 1.5M |");
    expect(exported.markdown).toContain("| Estimated cost | ≈$12.34");
    expect(exported.markdown).toContain("| claude-cli | 2.5k | 1.5M |");
  });

  it("returns raw numeric values in a versioned JSON payload", () => {
    const exported = buildWorkspaceStatsExport(snapshot(), {
      generatedAt: Date.UTC(2026, 7, 11, 12),
      showCostEstimates: true,
    });

    expect(exported.json.schemaVersion).toBe(
      WORKSPACE_STATS_EXPORT_SCHEMA_VERSION
    );
    expect(exported.json.totals.aiStepCount).toBe(2_500);
    expect(exported.json.totals.totalTokens).toBe(1_500_000);
    expect(exported.json.byHarness[0]).toMatchObject({
      harnessId: HARNESS_IDS.CLAUDE_CLI,
      aiStepCount: 2_500,
      totalTokens: 1_500_000,
      costUsd: 12.34,
    });
  });

  it("suppresses cost fields and cost rows when showCostEstimates is disabled", () => {
    const exported = buildWorkspaceStatsExport(snapshot(), {
      generatedAt: Date.UTC(2026, 7, 11, 12),
      showCostEstimates: false,
    });

    expect(exported.markdown).not.toContain("Estimated cost");
    expect(exported.markdown).not.toContain("$12.34");
    expect(exported.json.totals).not.toHaveProperty("costUsd");
    expect(exported.json.byHarness[0]).not.toHaveProperty("costUsd");
  });

  it("never exports workflow, run, path, model, or account identifiers", () => {
    const widenedSnapshot = {
      ...snapshot(),
      workflowName: "private-workflow-name",
      workflowKey: "private-workflow-key",
      runRef: "private-run-ref",
      filePath: "C:/private/workspace/workflow.json",
      modelId: "private-model-id",
      providerAccountId: "private-provider-account",
      totals: {
        ...snapshot().totals,
        runRef: "private-total-run-ref",
      },
      byHarness: {
        [HARNESS_IDS.CLAUDE_CLI]: {
          ...snapshot().byHarness[HARNESS_IDS.CLAUDE_CLI],
          filePath: "C:/private/workspace/run/events.jsonl",
          modelId: "private-harness-model-id",
        },
      },
    } as WorkspaceStatsSnapshot;

    const exported = buildWorkspaceStatsExport(widenedSnapshot, {
      generatedAt: Date.UTC(2026, 7, 11, 12),
      showCostEstimates: true,
    });
    const serialized = `${exported.markdown}\n${JSON.stringify(exported.json)}`;

    for (const identifier of [
      "private-workflow-name",
      "private-workflow-key",
      "private-run-ref",
      "C:/private/workspace/workflow.json",
      "C:/private/workspace/run/events.jsonl",
      "private-model-id",
      "private-harness-model-id",
      "private-provider-account",
      "private-total-run-ref",
    ]) {
      expect(serialized).not.toContain(identifier);
    }
  });
});
