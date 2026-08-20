import {
  HARNESS_IDS,
  HARNESS_QUOTA_SOURCES,
  HARNESS_USAGE_UNITS,
  WORKFLOW_TOKEN_COVERAGE,
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
  formatTokenCount,
  formatTokenTotal,
} from "@root/utils/TokenFormatting";
import { getUsageBarColorClass } from "@utils/usageBarColor";

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
      return "live from provider";
    case HARNESS_QUOTA_SOURCES.PROVIDER_LOG:
      return "from provider logs";
    case HARNESS_QUOTA_SOURCES.ENTERPRISE_API:
      return "enterprise API";
    case HARNESS_QUOTA_SOURCES.UNAVAILABLE:
      return "not reported by provider";
  }
}

function quotaSourceDescription(
  source: HarnessUsageSnapshot["quota"]["source"]
): string {
  switch (source) {
    case HARNESS_QUOTA_SOURCES.PROVIDER_LIVE:
      return "Fetched directly from the provider's API just now.";
    case HARNESS_QUOTA_SOURCES.PROVIDER_LOG:
      return "Read from the provider's local usage log, not a live API call.";
    case HARNESS_QUOTA_SOURCES.ENTERPRISE_API:
      return "Fetched from your organization's enterprise usage API.";
    case HARNESS_QUOTA_SOURCES.UNAVAILABLE:
      return "This provider doesn't expose quota limits here. Only ctrlyoke's own observed token counts below are available.";
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
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <span className="font-medium text-foreground">Usage</span>
        <span className="min-w-0 text-description-fg">
          Quota source:{" "}
          <span
            className="cursor-help underline decoration-dotted underline-offset-2"
            title={quotaSourceDescription(snapshot.quota.source)}
          >
            {quotaSourceLabel(snapshot.quota.source)}
          </span>
          {stale ? " · stale" : ""}
        </span>
      </div>
      <div className="text-description-fg">
        Quota freshness: {formatTimestamp(snapshot.quota.fetchedAt)}
      </div>
      {harnessId === HARNESS_IDS.COPILOT_CLI && (
        <div className="space-y-1 text-foreground">
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
            <div>
              {formatTokenTotal(
                observed[period]?.total,
                observed[period]?.partial
                  ? WORKFLOW_TOKEN_COVERAGE.PARTIAL
                  : WORKFLOW_TOKEN_COVERAGE.COMPLETE
              ) || "0"}{" "}
              tokens
            </div>
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
        <div className="space-y-2">
          {snapshot.quota.windows.map((window) => (
            <div key={window.id}>
              <div className="text-description-fg">
                {window.note ? (
                  <span
                    className="cursor-help underline decoration-dotted underline-offset-2"
                    title={window.note}
                  >
                    {window.label}
                  </span>
                ) : (
                  window.label
                )}
                :{" "}
                {window.isUnlimited
                  ? "Unlimited"
                  : `${formatQuotaValue(window.used, window.unit)}${
                      window.limit !== undefined
                        ? ` / ${formatQuotaValue(window.limit, window.unit)}`
                        : ""
                    }`}
                {window.resetAt !== undefined
                  ? ` · resets ${formatTimestamp(window.resetAt)}`
                  : ""}
                {isHarnessUsageWindowStale(snapshot.quota, window)
                  ? " · stale"
                  : ""}
              </div>
              {!window.isUnlimited && window.percentUsed !== undefined && (
                <UsagePercentBar percent={window.percentUsed} />
              )}
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

function UsagePercentBar({ percent }: { percent: number }) {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <div className="mt-1 mx-1 h-1.5 rounded-full bg-ctx-bar-track overflow-hidden">
      <div
        className={`h-full rounded-full ${getUsageBarColorClass(clamped)}`}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}

function formatQuotaValue(
  value: number | undefined,
  unit: (typeof HARNESS_USAGE_UNITS)[keyof typeof HARNESS_USAGE_UNITS]
): string {
  if (value === undefined) return "—";
  if (unit === HARNESS_USAGE_UNITS.TOKENS) return formatTokenCount(value);
  if (unit === HARNESS_USAGE_UNITS.PERCENT) return formatRoundedNumber(value);
  return String(value);
}

/** Rounds to at most one decimal place, dropping a trailing ".0". */
function formatRoundedNumber(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}
