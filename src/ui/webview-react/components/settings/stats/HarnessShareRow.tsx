import {
  HARNESS_INFO,
  WORKFLOW_TOKEN_COVERAGE,
} from "@root/types/DashboardConstants";
import type {
  HarnessId,
  HarnessShareMetric,
} from "@root/types/DashboardConstants";
import type { LifetimeHarnessContribution } from "@root/types/UsageTypes";
import {
  formatCostLabel,
  formatTokenCount,
  formatTokenTotal,
} from "@root/utils/TokenFormatting";
import { HarnessIcon } from "@components/shared";
import {
  formatHarnessSharePercentage,
  getHarnessShareMetricLabel,
} from "./HarnessShareBar";

export function HarnessShareRow({
  harnessId,
  contribution,
  percentage,
  metric,
  showCostEstimates,
}: {
  harnessId: HarnessId;
  contribution: LifetimeHarnessContribution;
  percentage: number;
  metric: HarnessShareMetric;
  showCostEstimates: boolean;
}) {
  const steps = formatTokenCount(contribution.attemptCount) || "0";
  const tokens =
    formatTokenTotal(
      contribution.total,
      contribution.partial
        ? WORKFLOW_TOKEN_COVERAGE.PARTIAL
        : WORKFLOW_TOKEN_COVERAGE.COMPLETE
    ) || "0";
  const cost = !showCostEstimates
    ? ""
    : formatCostLabel(contribution.costUsd, contribution.costPartial === true);
  const details = [`${steps} steps`, `${tokens} tokens`];
  if (cost) details.push(cost);

  return (
    <div
      className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 text-xs"
      aria-label={`${HARNESS_INFO[harnessId].name}, ${formatHarnessSharePercentage(percentage)} by ${getHarnessShareMetricLabel(metric)}, ${details.join(", ")}`}
    >
      <HarnessIcon harnessId={harnessId} size={16} />
      <span className="min-w-0 truncate text-foreground">
        {HARNESS_INFO[harnessId].name}
      </span>
      <span className="font-medium tabular-nums text-foreground">
        {formatHarnessSharePercentage(percentage)}
      </span>
      <span className="col-start-2 col-end-4 text-description-fg">
        {details.join(" · ")}
      </span>
    </div>
  );
}
