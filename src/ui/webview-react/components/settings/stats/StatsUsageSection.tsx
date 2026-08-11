import { useEffect, useState } from "react";
import {
  HARNESS_IDS,
  HARNESS_INFO,
  HARNESS_SHARE_METRICS,
  MESSAGE_TYPES,
} from "@root/types/DashboardConstants";
import type {
  HarnessId,
  HarnessShareMetric,
} from "@root/types/DashboardConstants";
import type { WorkspaceStatsSnapshot } from "@root/types/UsageTypes";
import { HarnessIcon } from "@components/shared";
import { ScopeToggle } from "@components/shared";
import { sendMessage } from "@hooks/useMessageHandler";
import { useHarnessUsageStore } from "@store/harnessUsageStore";
import { useWorkspaceStatsStore } from "@store/workspaceStatsStore";
import { UsageCard } from "./UsageCard";
import { StatTileGrid } from "./StatTileGrid";
import {
  HarnessShareBar,
  getHarnessShareMetricLabel,
  type HarnessShareSegment,
} from "./HarnessShareBar";
import { HarnessShareRow } from "./HarnessShareRow";

const ALL_HARNESS_IDS = Object.values(HARNESS_IDS) as HarnessId[];

interface Props {
  hideCost: boolean;
  isNarrow?: boolean;
}

export function StatsUsageSection({ hideCost, isNarrow = false }: Props) {
  const [shareMetric, setShareMetric] = useState<HarnessShareMetric>(
    HARNESS_SHARE_METRICS.AI_STEPS
  );

  useEffect(() => {
    sendMessage(MESSAGE_TYPES.REQUEST_WORKSPACE_STATS);
    sendMessage(MESSAGE_TYPES.REQUEST_HARNESS_USAGE);
  }, []);

  const snapshot = useWorkspaceStatsStore((state) => state.snapshot);
  const snapshotsByHarness = useHarnessUsageStore(
    (state) => state.snapshotsByHarness
  );

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-xs font-semibold uppercase text-description-fg tracking-wide">
            Workspace statistics
          </h3>
          <p className="text-xs text-description-fg mt-1">
            This workspace only
          </p>
        </div>
        <button
          type="button"
          className="text-xs text-link-fg hover:underline shrink-0"
          onClick={() => sendMessage(MESSAGE_TYPES.REFRESH_WORKSPACE_STATS)}
        >
          Refresh
        </button>
      </div>
      {snapshot && (
        <StatTileGrid
          snapshot={snapshot}
          isNarrow={isNarrow}
          hideCost={hideCost}
        />
      )}
      {!snapshot && (
        <div className="rounded border border-panel-border bg-panel-bg p-3 text-xs text-description-fg">
          Workspace statistics: loading…
        </div>
      )}
      {snapshot && (
        <HarnessShare
          snapshot={snapshot}
          metric={shareMetric}
          onMetricChange={setShareMetric}
          hideCost={hideCost}
        />
      )}
      <div className="space-y-4">
        {ALL_HARNESS_IDS.map((harnessId) => (
          <div key={harnessId} className="space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <HarnessIcon harnessId={harnessId} size={16} />
              <span>{HARNESS_INFO[harnessId].name}</span>
            </div>
            <UsageCard
              harnessId={harnessId}
              snapshot={snapshotsByHarness[harnessId]}
              hideCost={hideCost}
            />
          </div>
        ))}
      </div>
      <p className="text-xs text-description-fg">
        Totals are ctrlyoke-observed only; they do not include harness activity
        outside ctrlyoke. Costs are estimates at API list prices, not
        subscription spend.
      </p>
    </div>
  );
}

function HarnessShare({
  snapshot,
  metric,
  onMetricChange,
  hideCost,
}: {
  snapshot: WorkspaceStatsSnapshot;
  metric: HarnessShareMetric;
  onMetricChange: (metric: HarnessShareMetric) => void;
  hideCost: boolean;
}) {
  const contributions = ALL_HARNESS_IDS.map((harnessId, index) => ({
    harnessId,
    index,
    contribution: snapshot.byHarness[harnessId],
  }));
  const valueFor = (harnessId: HarnessId) => {
    const contribution = snapshot.byHarness[harnessId];
    const value =
      metric === HARNESS_SHARE_METRICS.AI_STEPS
        ? contribution?.attemptCount
        : contribution?.total;
    return value !== undefined && Number.isFinite(value) && value > 0
      ? value
      : 0;
  };
  const total = contributions.reduce(
    (sum, { harnessId }) => sum + valueFor(harnessId),
    0
  );
  const ranked = contributions
    .flatMap(({ harnessId, index, contribution }) =>
      contribution && valueFor(harnessId) > 0
        ? [{ harnessId, index, contribution }]
        : []
    )
    .sort(
      (left, right) =>
        valueFor(right.harnessId) - valueFor(left.harnessId) ||
        left.index - right.index
    );
  const segments: HarnessShareSegment[] =
    total > 0
      ? ranked.map(({ harnessId }) => ({
          harnessId,
          percentage: (valueFor(harnessId) / total) * 100,
        }))
      : [];
  const unused = contributions
    .filter(({ harnessId }) => valueFor(harnessId) === 0)
    .map(({ harnessId }) => HARNESS_INFO[harnessId].name);
  const metricLabel = getHarnessShareMetricLabel(metric);

  return (
    <section className="space-y-3" aria-labelledby="harness-share-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4
          id="harness-share-heading"
          className="text-xs font-semibold uppercase tracking-wide text-description-fg"
        >
          Harness share
        </h4>
        <ScopeToggle
          value={metric}
          onChange={onMetricChange}
          ariaLabel="Harness share metric"
          options={[
            {
              value: HARNESS_SHARE_METRICS.AI_STEPS,
              label: "By AI steps",
              icon: "codicon-list-ordered",
              title: "Compare harnesses by AI step count",
            },
            {
              value: HARNESS_SHARE_METRICS.TOKENS,
              label: "By tokens",
              icon: "codicon-symbol-numeric",
              title: "Compare harnesses by total tokens",
            },
          ]}
        />
      </div>
      <HarnessShareBar segments={segments} metric={metric} />
      <div className="space-y-2">
        {ranked.map(({ harnessId, contribution }) => (
          <HarnessShareRow
            key={harnessId}
            harnessId={harnessId}
            contribution={contribution!}
            percentage={(valueFor(harnessId) / total) * 100}
            metric={metric}
            hideCost={hideCost}
          />
        ))}
        {unused.length > 0 && (
          <p className="text-xs text-description-fg">
            Unused: {unused.join(", ")}
          </p>
        )}
        {total === 0 && (
          <p className="text-xs text-description-fg">
            No {metricLabel} recorded yet.
          </p>
        )}
      </div>
    </section>
  );
}
