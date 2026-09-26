import {
  HARNESS_IDS,
  WORKFLOW_TOKEN_COVERAGE,
  type AttemptCostSource,
  type HarnessId,
  type RunOutcomeBucket,
  type WorkflowTokenCoverage,
} from "@root/types/DashboardConstants";
import type {
  LifetimeHarnessContribution,
  WorkspaceStatsSnapshot,
} from "@root/types/UsageTypes";
import {
  formatCostLabel,
  formatCostSourcePhrase,
  formatTokenCount,
  formatTokenTotal,
} from "@root/utils/TokenFormatting";
import { formatDuration } from "@utils/time";

export const WORKSPACE_STATS_EXPORT_SCHEMA_VERSION = 1 as const;

const WORKSPACE_SCOPE = "workspace-local" as const;
const LIFETIME_PERIOD_START = "workspace-lifetime" as const;
const OBSERVED_PROVENANCE = ["ctrlyoke-observed"] as const;
const FULL_DISCLAIMER =
  "Totals are ctrlyoke-observed only and do not include harness activity outside ctrlyoke. Cost values are estimated from token counts at API list prices, or taken directly from a harness's own reported figure when one is available; either way, they are not subscription spend.";
const HIDDEN_COST_DISCLAIMER =
  "Totals are ctrlyoke-observed only and do not include harness activity outside ctrlyoke. Cost estimates are omitted by the workspace setting.";

type ExportPeriod = {
  start: typeof LIFETIME_PERIOD_START;
  end: string;
};

interface ExportCostFields {
  costUsd?: number;
  costCoverage?: "complete" | "partial";
  costSources?: readonly AttemptCostSource[];
}

export interface WorkspaceStatsExportPayload {
  schemaVersion: typeof WORKSPACE_STATS_EXPORT_SCHEMA_VERSION;
  scope: typeof WORKSPACE_SCOPE;
  generatedAt: string;
  period: ExportPeriod;
  provenance: typeof OBSERVED_PROVENANCE;
  disclaimer: string;
  totals: {
    workflowCount: number;
    runCount: number;
    aiStepCount: number;
    totalTokens: number;
    totalActiveExecutionMs: number;
    outcomes: Record<RunOutcomeBucket, number>;
    wallClockDurationRunCount: number;
    skippedRunCount: number;
    backfill: {
      state: WorkspaceStatsSnapshot["backfill"]["state"];
      scanned: number;
      total: number;
    };
    tokenCoverage: WorkflowTokenCoverage;
  } & ExportCostFields;
  byHarness: Array<
    {
      harnessId: HarnessId;
      aiStepCount: number;
      totalTokens: number;
      tokenCoverage: WorkflowTokenCoverage;
    } & ExportCostFields
  >;
}

export interface WorkspaceStatsExport {
  markdown: string;
  json: WorkspaceStatsExportPayload;
}

export interface WorkspaceStatsExportOptions {
  generatedAt: number;
  showCostEstimates: boolean;
}

function formatDate(value: number): string {
  return new Date(value).toISOString();
}

function tokenCoverage(
  contribution: LifetimeHarnessContribution
): WorkflowTokenCoverage {
  return contribution.partial
    ? WORKFLOW_TOKEN_COVERAGE.PARTIAL
    : WORKFLOW_TOKEN_COVERAGE.COMPLETE;
}

function costFields(
  contribution: LifetimeHarnessContribution,
  showCostEstimates: boolean
): ExportCostFields {
  if (!showCostEstimates || contribution.costUsd === undefined) return {};

  return {
    costUsd: contribution.costUsd,
    costCoverage: contribution.costPartial ? "partial" : "complete",
    ...(contribution.costSources?.length
      ? { costSources: [...contribution.costSources] }
      : {}),
  };
}

function hasUsage(contribution: LifetimeHarnessContribution): boolean {
  return (
    contribution.attemptCount > 0 ||
    contribution.total > 0 ||
    contribution.costUsd !== undefined
  );
}

function projectHarness(
  harnessId: HarnessId,
  contribution: LifetimeHarnessContribution,
  showCostEstimates: boolean
): WorkspaceStatsExportPayload["byHarness"][number] {
  return {
    harnessId,
    aiStepCount: contribution.attemptCount,
    totalTokens: contribution.total,
    tokenCoverage: tokenCoverage(contribution),
    ...costFields(contribution, showCostEstimates),
  };
}

function numberLabel(value: number): string {
  return value.toLocaleString("en-US");
}

function markdownTokenTotal(
  total: number,
  coverage: WorkflowTokenCoverage
): string {
  return formatTokenTotal(total, coverage) || "0";
}

/**
 * Build shareable workspace totals without carrying any run or workflow
 * identity across the export boundary. Keep this projection explicit: the
 * snapshot is intentionally richer than the public export contract.
 */
export function buildWorkspaceStatsExport(
  snapshot: WorkspaceStatsSnapshot,
  { generatedAt, showCostEstimates }: WorkspaceStatsExportOptions
): WorkspaceStatsExport {
  const period: ExportPeriod = {
    start: LIFETIME_PERIOD_START,
    end: formatDate(snapshot.updatedAt),
  };
  const disclaimer = !showCostEstimates ? HIDDEN_COST_DISCLAIMER : FULL_DISCLAIMER;
  const totals = {
    workflowCount: snapshot.workflowCount,
    runCount: snapshot.runCount,
    aiStepCount: snapshot.totals.attemptCount,
    totalTokens: snapshot.totals.total,
    totalActiveExecutionMs: snapshot.totalActiveExecutionMs,
    outcomes: { ...snapshot.outcomes },
    wallClockDurationRunCount: snapshot.wallClockDurationRunCount,
    skippedRunCount: snapshot.skippedRunCount,
    backfill: { ...snapshot.backfill },
    tokenCoverage: tokenCoverage(snapshot.totals),
    ...costFields(snapshot.totals, showCostEstimates),
  };
  const byHarness = (Object.values(HARNESS_IDS) as HarnessId[]).flatMap(
    (harnessId) => {
      const contribution = snapshot.byHarness[harnessId];
      return contribution && hasUsage(contribution)
        ? [projectHarness(harnessId, contribution, showCostEstimates)]
        : [];
    }
  );
  const json: WorkspaceStatsExportPayload = {
    schemaVersion: WORKSPACE_STATS_EXPORT_SCHEMA_VERSION,
    scope: WORKSPACE_SCOPE,
    generatedAt: formatDate(generatedAt),
    period,
    provenance: OBSERVED_PROVENANCE,
    disclaimer,
    totals,
    byHarness,
  };

  const harnessRows = byHarness.map((harness) => {
    const cost = !showCostEstimates
      ? ""
      : formatCostLabel(harness.costUsd, harness.costCoverage === "partial");
    return !showCostEstimates
      ? `| ${harness.harnessId} | ${formatTokenCount(harness.aiStepCount) || "0"} | ${markdownTokenTotal(harness.totalTokens, harness.tokenCoverage)} |`
      : `| ${harness.harnessId} | ${formatTokenCount(harness.aiStepCount) || "0"} | ${markdownTokenTotal(harness.totalTokens, harness.tokenCoverage)} | ${cost || "—"} |`;
  });
  const markdown = [
    "# ctrlyoke workspace statistics",
    "",
    `- Scope: ${WORKSPACE_SCOPE}`,
    `- Period: ${period.start} through ${period.end}`,
    `- Generated: ${json.generatedAt}`,
    `- Provenance: ${OBSERVED_PROVENANCE.join(", ")}`,
    `- Caveat: ${disclaimer}`,
    `- Cost estimate caveat: ${
      showCostEstimates
        ? "Cost values are estimated from token counts at API list prices, or taken directly from a harness's own reported figure when one is available; either way, they are not subscription spend."
        : "Cost estimates are omitted by the workspace setting."
    }`,
    "",
    "## Totals",
    "",
    "| Metric | Value |",
    "| --- | ---: |",
    `| Workflows | ${numberLabel(snapshot.workflowCount)} |`,
    `| Runs | ${numberLabel(snapshot.runCount)} |`,
    `| AI steps | ${formatTokenCount(snapshot.totals.attemptCount) || "0"} |`,
    `| Total tokens | ${markdownTokenTotal(snapshot.totals.total, tokenCoverage(snapshot.totals))} |`,
    `| Time executing | ${formatDuration(snapshot.totalActiveExecutionMs)} |`,
    `| Completed / stopped / error | ${numberLabel(snapshot.outcomes.completed)} / ${numberLabel(snapshot.outcomes.stopped)} / ${numberLabel(snapshot.outcomes.error)} |`,
    `| Wall-clock duration runs | ${numberLabel(snapshot.wallClockDurationRunCount)} |`,
    `| Unreadable runs | ${numberLabel(snapshot.skippedRunCount)} |`,
    ...(!showCostEstimates
      ? []
      : [
          `| Estimated cost | ${
            formatCostLabel(
              snapshot.totals.costUsd,
              snapshot.totals.costPartial === true
            ) || "—"
          } (${formatCostSourcePhrase(snapshot.totals.costSources)}) |`,
        ]),
    "",
    "## Harness totals",
    "",
    ...(!showCostEstimates
      ? ["| Harness ID | AI steps | Tokens |", "| --- | ---: | ---: |"]
      : [
          "| Harness ID | AI steps | Tokens | Estimated cost |",
          "| --- | ---: | ---: | ---: |",
        ]),
    ...(harnessRows.length
      ? harnessRows
      : [!showCostEstimates ? "| — | 0 | 0 |" : "| — | 0 | 0 | — |"]),
    "",
  ].join("\n");

  return { markdown, json };
}
