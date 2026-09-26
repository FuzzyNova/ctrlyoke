import type { WorkspaceStatsSnapshot } from "@root/types/UsageTypes";
import {
  WORKSPACE_STATS_BACKFILL_STATES,
  WORKFLOW_TOKEN_COVERAGE,
} from "@root/types/DashboardConstants";
import {
  formatCostLabel,
  formatCostSourcePhrase,
  formatTokenTotal,
} from "@root/utils/TokenFormatting";
import { formatDuration } from "@utils/time";

interface Props {
  snapshot: WorkspaceStatsSnapshot;
  isNarrow: boolean;
  showCostEstimates: boolean;
}

function numberLabel(value: number): string {
  return value.toLocaleString("en-US");
}

function Tile({
  label,
  value,
  children,
}: {
  label: string;
  value: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="rounded border border-panel-border bg-panel-bg p-3 min-w-0">
      <div className="text-xs text-description-fg">{label}</div>
      <div className="mt-1 text-lg font-semibold text-foreground break-words">
        {value}
      </div>
      {children && (
        <div className="mt-1 text-xs text-description-fg">{children}</div>
      )}
    </div>
  );
}

export function StatTileGrid({ snapshot, isNarrow, showCostEstimates }: Props) {
  const tokenCoverage = snapshot.totals.partial
    ? WORKFLOW_TOKEN_COVERAGE.PARTIAL
    : WORKFLOW_TOKEN_COVERAGE.COMPLETE;
  const costPartial = snapshot.totals.costPartial === true;
  const tiles = [
    <Tile
      key="workflows"
      label="Workflows"
      value={numberLabel(snapshot.workflowCount)}
    >
      {numberLabel(snapshot.runCount)} runs
    </Tile>,
    <Tile
      key="steps"
      label="AI steps"
      value={numberLabel(snapshot.totals.attemptCount)}
    />,
    <Tile
      key="tokens"
      label="Total tokens"
      value={formatTokenTotal(snapshot.totals.total, tokenCoverage) || "—"}
    />,
    <Tile
      key="time"
      label="Time executing"
      value={formatDuration(snapshot.totalActiveExecutionMs)}
    />,
    <Tile
      key="outcomes"
      label="Run outcomes"
      value={numberLabel(snapshot.runCount)}
    >
      {numberLabel(snapshot.outcomes.completed)} completed ·{" "}
      {numberLabel(snapshot.outcomes.stopped)} stopped ·{" "}
      {numberLabel(snapshot.outcomes.error)} error
    </Tile>,
  ];

  if (showCostEstimates) {
    tiles.splice(
      3,
      0,
      <Tile
        key="cost"
        label="Estimated cost"
        value={formatCostLabel(snapshot.totals.costUsd, costPartial) || "—"}
      >
        {formatCostSourcePhrase(snapshot.totals.costSources)}
      </Tile>
    );
  }

  return (
    <div
      className={`grid gap-2 ${isNarrow ? "grid-cols-1" : "grid-cols-2 lg:grid-cols-3"}`}
    >
      {tiles}
      {snapshot.backfill.state === WORKSPACE_STATS_BACKFILL_STATES.RUNNING && (
        <div className="col-span-full rounded border border-panel-border bg-panel-bg px-3 py-2 text-xs text-description-fg">
          <div>
            Building history… {numberLabel(snapshot.backfill.scanned)}/
            {numberLabel(snapshot.backfill.total)}
          </div>
          <div className="mt-1">
            Current totals are partial and still building.
          </div>
        </div>
      )}
      {snapshot.wallClockDurationRunCount > 0 && (
        <div className="col-span-full text-xs text-description-fg">
          Includes {numberLabel(snapshot.wallClockDurationRunCount)} runs
          measured as wall clock.
        </div>
      )}
      {snapshot.skippedRunCount > 0 && (
        <div className="col-span-full text-xs text-description-fg">
          {numberLabel(snapshot.skippedRunCount)} runs skipped because their
          history could not be read.
        </div>
      )}
    </div>
  );
}
