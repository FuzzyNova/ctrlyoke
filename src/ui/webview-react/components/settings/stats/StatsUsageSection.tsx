import { useCallback, useEffect, useState } from "react";
import {
  HARNESS_IDS,
  HARNESS_INFO,
  HARNESS_SHARE_METRICS,
  MESSAGE_TYPES,
  SETTING_SCOPES,
  SETTING_PATHS,
} from "@root/types/DashboardConstants";
import type {
  HarnessId,
  HarnessShareMetric,
  SettingWriteScope,
} from "@root/types/DashboardConstants";
import type { WorkspaceStatsSnapshot } from "@root/types/UsageTypes";
import type { FullGlobalSettings } from "@root/types/WebviewMessageTypes";
import type { HarnessColorSettings } from "@root/types/CtrlYokeSettings";
import {
  HarnessIcon,
  ModelPricingEditor,
  NumberField,
  SettingInputRow,
  SettingToggleRow,
  ScopeToggle,
  SplitButton,
  type SplitButtonOption,
} from "@components/shared";
import { sendMessage } from "@hooks/useMessageHandler";
import { getVsCodeApi, isStandalone } from "@hooks/useVsCodeApi";
import { useHarnessUsageStore } from "@store/harnessUsageStore";
import { useSettingsStore } from "@store/settingsStore";
import { useWorkspaceStatsStore } from "@store/workspaceStatsStore";
import { WebviewLog } from "@utils/logger";
import { buildWorkspaceStatsExport } from "@utils/workspaceStatsExport";
import { UsageCard } from "./UsageCard";
import { StatTileGrid } from "./StatTileGrid";
import {
  HarnessShareBar,
  getHarnessShareMetricLabel,
  type HarnessShareSegment,
} from "./HarnessShareBar";
import { HarnessShareRow } from "./HarnessShareRow";
import type { UsagePercentDirection } from "@root/utils/StatuslineFormat";

const ALL_HARNESS_IDS = Object.values(HARNESS_IDS) as HarnessId[];

interface Props {
  hideCost: boolean;
  isNarrow?: boolean;
  settings?: FullGlobalSettings;
  activeScope: SettingWriteScope;
  onUpdate?: (path: string, value: unknown) => void;
  onReset?: (path: string) => void;
}

export function StatsUsageSection({
  hideCost,
  isNarrow = false,
  settings,
  activeScope,
  onUpdate,
  onReset,
}: Props) {
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
  const percentDirection = useSettingsStore(
    (state) =>
      state.fullGlobalSettings?.settings.usageTracking.percentDirection ??
      "used"
  ) as UsagePercentDirection;

  const updatePercentDirection = (value: UsagePercentDirection) => {
    sendMessage(MESSAGE_TYPES.UPDATE_GLOBAL_SETTING, {
      path: SETTING_PATHS.USAGE_TRACKING_PERCENT_DIRECTION,
      value,
      scope: activeScope,
    });
  };

  const getExport = useCallback(
    () =>
      snapshot
        ? buildWorkspaceStatsExport(snapshot, {
            generatedAt: Date.now(),
            hideCost,
          })
        : undefined,
    [hideCost, snapshot]
  );

  const downloadExport = useCallback(
    (content: string, fileName: string, mimeType: string) => {
      if (isStandalone) {
        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = fileName;
        anchor.click();
        URL.revokeObjectURL(url);
        return;
      }

      getVsCodeApi().postMessage({
        type: MESSAGE_TYPES.EXPORT_OUTPUT,
        content,
        fileName,
      });
    },
    []
  );

  const copySummary = useCallback(() => {
    const exportData = getExport();
    if (!exportData || !navigator.clipboard) {
      WebviewLog.warn(
        "[StatsUsageSection] Workspace stats export is unavailable"
      );
      return;
    }

    void navigator.clipboard.writeText(exportData.markdown).catch((error) => {
      WebviewLog.error(
        "[StatsUsageSection] Failed to copy workspace stats export",
        error
      );
    });
  }, [getExport]);

  const downloadMarkdown = useCallback(() => {
    const exportData = getExport();
    if (!exportData) return;
    downloadExport(
      exportData.markdown,
      "ctrlyoke-workspace-stats.md",
      "text/markdown"
    );
  }, [downloadExport, getExport]);

  const downloadJson = useCallback(() => {
    const exportData = getExport();
    if (!exportData) return;
    downloadExport(
      JSON.stringify(exportData.json, null, 2),
      "ctrlyoke-workspace-stats.json",
      "application/json"
    );
  }, [downloadExport, getExport]);

  const exportOptions: SplitButtonOption[] = [
    {
      label: "Copy summary (Markdown)",
      value: "copy-summary",
      onClick: copySummary,
    },
    {
      label: "Download Markdown",
      value: "download-markdown",
      onClick: downloadMarkdown,
    },
    {
      label: "Download JSON",
      value: "download-json",
      onClick: downloadJson,
    },
  ];

  const usageTracking = settings?.settings.usageTracking;
  const sources = settings?.sources;
  const userScopeOnly = activeScope === SETTING_SCOPES.WORKSPACE;

  return (
    <div className="space-y-4">
      {usageTracking && (
        <section
          className="space-y-3"
          aria-labelledby="usage-collection-heading"
        >
          <div>
            <h3
              id="usage-collection-heading"
              className="text-xs font-semibold uppercase text-description-fg tracking-wide"
            >
              Usage collection
            </h3>
            <p className="text-xs text-description-fg mt-1">
              Tracks token, cost, and quota usage per harness for the stats on
              this page.
            </p>
            <p className="text-xs text-description-fg mt-1">
              Local only — nothing is uploaded or shared with ctrlyoke. Usage is
              read from your own harness sessions and saved in files on this
              machine.
            </p>
          </div>
          <div className="space-y-3">
            <SettingToggleRow
              label="Track harness usage"
              description="Watch ctrlyoke-started harness sessions and record their token, cost, and quota usage. Applies machine-wide, across all your workspaces."
              checked={usageTracking.enabled}
              onChange={(value) => onUpdate?.("usageTracking.enabled", value)}
              disabled={userScopeOnly}
              path="usageTracking.enabled"
              sources={sources}
              onReset={onReset}
              activeScope={activeScope}
            />
            {userScopeOnly && (
              <p className="text-xs text-warning-fg -mt-2" role="note">
                Track harness usage is user-scoped and cannot be changed from
                workspace scope. Switch the scope selector to User to edit it.
              </p>
            )}
            <SettingToggleRow
              label="Refresh quota from provider"
              description="Actively check each harness's CLI for your current quota and rate-limit usage, so the numbers on this page stay up to date."
              checked={usageTracking.providerRefreshEnabled}
              onChange={(value) =>
                onUpdate?.("usageTracking.providerRefreshEnabled", value)
              }
              disabled={!usageTracking.enabled}
              path="usageTracking.providerRefreshEnabled"
              sources={sources}
              onReset={onReset}
              activeScope={activeScope}
            />
            <SettingToggleRow
              label="Save usage history"
              description="Keep a running record of usage in this workspace so totals and stats survive restarts. Off keeps usage in memory for this session only."
              checked={usageTracking.persistObservedUsage}
              onChange={(value) =>
                onUpdate?.("usageTracking.persistObservedUsage", value)
              }
              disabled={!usageTracking.enabled}
              path="usageTracking.persistObservedUsage"
              sources={sources}
              onReset={onReset}
              activeScope={activeScope}
            />
            <NumberField
              id="usage-tracking-warning-percent-used"
              label="Usage warning threshold"
              value={usageTracking.warningPercentUsed}
              min={0}
              max={100}
              step={1}
              onChange={(value) =>
                onUpdate?.("usageTracking.warningPercentUsed", value)
              }
              note="Percentage of quota used at which near-limit warnings are shown."
              path="usageTracking.warningPercentUsed"
              sources={sources}
              onReset={onReset}
              activeScope={activeScope}
            />
          </div>
        </section>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-panel-border bg-panel-bg px-2 py-1.5">
        <div>
          <p className="text-sm text-foreground">Quota percent direction</p>
          <p className="text-xs text-description-fg">
            Choose whether usage percentages show used or remaining capacity.
          </p>
        </div>
        <ScopeToggle
          value={percentDirection}
          onChange={updatePercentDirection}
          ariaLabel="Quota percent direction"
          options={[
            {
              value: "used",
              label: "Used",
              icon: "codicon-arrow-up",
              title: "Show the percentage already used",
            },
            {
              value: "remaining",
              label: "Remaining",
              icon: "codicon-arrow-down",
              title: "Show the percentage remaining",
            },
          ]}
        />
      </div>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-xs font-semibold uppercase text-description-fg tracking-wide">
            Workspace statistics
          </h3>
          <p className="text-xs text-description-fg mt-1">
            This workspace only
          </p>
        </div>
        <SplitButton
          mainLabel="Refresh"
          mainAction={() => sendMessage(MESSAGE_TYPES.REFRESH_WORKSPACE_STATS)}
          options={exportOptions}
          variant="secondary"
          mainTitle="Refresh workspace statistics"
          dropdownTitle="Export workspace statistics"
          dropdownAriaLabel="Export workspace statistics"
          dropdownDisabled={!snapshot}
        />
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
          harnessColorSettings={settings?.settings.ui.harnessColors}
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
        outside ctrlyoke. Costs are estimated from token counts at API list
        prices, or taken directly from a harness's own reported figure when one
        is available; either way, they are not subscription spend.
      </p>
      {settings && (
        <section
          className="pt-3 border-t border-panel-border space-y-3"
          aria-labelledby="model-pricing-heading"
        >
          <div>
            <h3
              id="model-pricing-heading"
              className="text-xs font-semibold uppercase text-description-fg tracking-wide"
            >
              Model pricing overrides
            </h3>
            <p className="text-xs text-description-fg mt-1">
              Override USD-per-million-token rates for a harness and model.
              Leave optional cache and reasoning rates blank when they are not
              reported separately.
            </p>
          </div>
          <SettingInputRow
            label="Rates"
            path="modelPricing"
            sources={sources}
            onReset={onReset}
            activeScope={activeScope}
          >
            <ModelPricingEditor
              value={settings.settings.modelPricing}
              onChange={(value) => onUpdate?.("modelPricing", value)}
            />
          </SettingInputRow>
        </section>
      )}
    </div>
  );
}

function HarnessShare({
  snapshot,
  metric,
  onMetricChange,
  hideCost,
  harnessColorSettings,
}: {
  snapshot: WorkspaceStatsSnapshot;
  metric: HarnessShareMetric;
  onMetricChange: (metric: HarnessShareMetric) => void;
  hideCost: boolean;
  harnessColorSettings?: HarnessColorSettings;
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
      <HarnessShareBar
        segments={segments}
        metric={metric}
        harnessColorSettings={harnessColorSettings}
      />
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
