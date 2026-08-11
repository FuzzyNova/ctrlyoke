import {
  HARNESS_IDS,
  HARNESS_QUOTA_SOURCES,
} from "@root/types/DashboardConstants";
import type { HarnessId } from "@root/types/DashboardConstants";
import {
  isHarnessQuotaStale,
  isHarnessUsageWindowStale,
} from "@root/types/UsageTypes";
import type { HarnessUsageSnapshot } from "@root/types/UsageTypes";
import {
  formatCostLabel,
  formatCostSourcePhrase,
} from "@root/utils/TokenFormatting";

function formatTimestamp(value: number | undefined): string {
  return value === undefined
    ? "Not available"
    : new Date(value).toLocaleString();
}

function quotaSourceLabel(
  source: HarnessUsageSnapshot["quota"]["source"]
): string {
  switch (source) {
    case HARNESS_QUOTA_SOURCES.PROVIDER_LIVE:
      return "provider-live";
    case HARNESS_QUOTA_SOURCES.PROVIDER_LOG:
      return "provider-log";
    case HARNESS_QUOTA_SOURCES.ENTERPRISE_API:
      return "enterprise-api";
    case HARNESS_QUOTA_SOURCES.UNAVAILABLE:
      return "observed only";
  }
}

export function UsageCard({
  snapshot,
  harnessId,
  hideCost,
}: {
  snapshot: HarnessUsageSnapshot | undefined;
  harnessId: HarnessId;
  hideCost: boolean;
}) {
  if (!snapshot) {
    return (
      <div className="rounded border border-panel-border bg-panel-bg p-2 text-xs text-description-fg">
        Usage: loading…
        {harnessId === HARNESS_IDS.COPILOT_CLI && (
          <div className="mt-1">
            <a
              className="text-link-fg hover:underline"
              href="https://github.com/settings/copilot"
              target="_blank"
              rel="noreferrer"
            >
              Open GitHub usage dashboard
            </a>
          </div>
        )}
      </div>
    );
  }

  const stale = isHarnessQuotaStale(snapshot.quota);
  const observed = snapshot.observed;
  return (
    <div className="rounded border border-panel-border bg-panel-bg p-2 text-xs space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-foreground">Usage</span>
        <span className="text-description-fg">
          Quota source: {quotaSourceLabel(snapshot.quota.source)}
          {stale ? " · stale" : ""}
        </span>
      </div>
      <div className="text-description-fg">
        Quota freshness: {formatTimestamp(snapshot.quota.fetchedAt)}
      </div>
      <div className="text-description-fg">
        Observed source:{" "}
        <span className="text-foreground">ctrlyoke-observed</span>
      </div>
      {harnessId === HARNESS_IDS.COPILOT_CLI && (
        <div className="space-y-1 text-foreground">
          <div>AI credits: not reported by the local usage feed</div>
          <div className="text-description-fg">
            Tokens are secondary context for Copilot; billing uses AI credits or
            premium requests.
          </div>
          <a
            className="text-link-fg hover:underline"
            href="https://github.com/settings/copilot"
            target="_blank"
            rel="noreferrer"
          >
            Open GitHub usage dashboard
          </a>
        </div>
      )}
      <div className="grid grid-cols-3 gap-2 text-foreground">
        {(["daily", "weekly", "monthly"] as const).map((period) => (
          <div key={period} className="rounded bg-input-bg px-2 py-1">
            <div className="text-description-fg capitalize">{period}</div>
            <div>{observed[period]?.total ?? 0} tokens</div>
          </div>
        ))}
      </div>
      {!hideCost &&
        harnessId !== HARNESS_IDS.COPILOT_CLI &&
        observed.monthly?.costUsd !== undefined && (
          <div className="text-description-fg">
            Observed token value:{" "}
            {formatCostLabel(
              observed.monthly.costUsd,
              observed.monthly.costPartial === true
            )}{" "}
            {formatCostSourcePhrase(observed.monthly.costSources)}
          </div>
        )}
      {snapshot.quota.windows.length > 0 && (
        <div className="space-y-1">
          {snapshot.quota.windows.map((window) => (
            <div key={window.id} className="text-description-fg">
              {window.label}: {window.used ?? "—"}
              {window.limit !== undefined ? ` / ${window.limit}` : ""}
              {window.resetAt !== undefined
                ? ` · resets ${formatTimestamp(window.resetAt)}`
                : ""}
              {isHarnessUsageWindowStale(snapshot.quota, window)
                ? " · stale"
                : ""}
            </div>
          ))}
        </div>
      )}
      <div className="text-description-fg">
        Last safe error: {snapshot.quota.errorCode ?? "none"}
      </div>
    </div>
  );
}
