import { useEffect } from "react";
import {
  HARNESS_IDS,
  HARNESS_INFO,
  MESSAGE_TYPES,
} from "@root/types/DashboardConstants";
import type { HarnessId } from "@root/types/DashboardConstants";
import { HarnessIcon } from "@components/shared";
import { sendMessage } from "@hooks/useMessageHandler";
import { useHarnessUsageStore } from "@store/harnessUsageStore";
import { useWorkspaceStatsStore } from "@store/workspaceStatsStore";
import { UsageCard } from "./UsageCard";
import { StatTileGrid } from "./StatTileGrid";

const ALL_HARNESS_IDS = Object.values(HARNESS_IDS) as HarnessId[];

interface Props {
  hideCost: boolean;
  isNarrow?: boolean;
}

export function StatsUsageSection({ hideCost, isNarrow = false }: Props) {
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
