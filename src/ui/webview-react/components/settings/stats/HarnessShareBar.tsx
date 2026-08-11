import {
  HARNESS_CHART_COLORS,
  HARNESS_INFO,
  HARNESS_SHARE_METRICS,
} from "@root/types/DashboardConstants";
import type {
  HarnessId,
  HarnessShareMetric,
} from "@root/types/DashboardConstants";

export interface HarnessShareSegment {
  harnessId: HarnessId;
  percentage: number;
}

export function formatHarnessSharePercentage(percentage: number): string {
  if (!Number.isFinite(percentage) || percentage <= 0) return "0%";
  const rounded = Math.round(percentage * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}%`;
}

export function getHarnessShareMetricLabel(metric: HarnessShareMetric): string {
  return metric === HARNESS_SHARE_METRICS.AI_STEPS ? "AI steps" : "tokens";
}

export function HarnessShareBar({
  segments,
  metric,
}: {
  segments: readonly HarnessShareSegment[];
  metric: HarnessShareMetric;
}) {
  const label = getHarnessShareMetricLabel(metric);

  return (
    <div aria-label={`Harness share by ${label}`}>
      <div
        className="h-3 w-full overflow-hidden rounded bg-input-bg"
        aria-hidden="true"
      >
        <div className="flex h-full w-full">
          {segments.map(({ harnessId, percentage }) => (
            <div
              key={harnessId}
              className="h-full min-w-0"
              style={{
                width: `${percentage}%`,
                backgroundColor: HARNESS_CHART_COLORS[harnessId],
              }}
              title={`${HARNESS_INFO[harnessId].name}: ${formatHarnessSharePercentage(percentage)} ${label}`}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
