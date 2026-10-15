import {
  HARNESS_USAGE_STATUS_CODES,
  HARNESS_USAGE_UNITS,
} from "@root/types/DashboardConstants";
import type {
  HarnessUsageSnapshot,
  HarnessUsageWindow,
} from "@root/types/UsageTypes";
import {
  HARNESS_STATUS_STRINGS,
  HARNESS_VERSION_STATUSES,
  type HarnessStatusInfo,
} from "../types/messages";
import {
  formatHarnessInstallGuidance,
  formatHarnessVersionGuidance,
} from "@root/utils/HarnessVersion";
import {
  STATUS_LINE_USAGE_DIRECTIONS,
  formatUsagePercentForDisplay,
  type UsagePercentDirection,
} from "@root/utils/StatuslineFormat";
import { formatFutureTime, formatTimestamp } from "./time";

/**
 * True only for a window whose `used`/`limit` are real provider counts worth
 * spelling out. Claude and Codex encode a percentage as `used: pct, limit: 100`
 * with `unit: PERCENT`, so the unit check is what stops their tooltips from
 * gaining a meaningless "(37 / 100)" fragment.
 */
function hasFiniteQuotaTotals(window: HarnessUsageWindow): boolean {
  return (
    window.unit !== HARNESS_USAGE_UNITS.PERCENT &&
    Number.isFinite(window.used) &&
    Number.isFinite(window.limit)
  );
}

function formatQuotaNumber(value: number): string {
  return value.toLocaleString();
}

export interface HarnessUsageDisplay {
  /** Bare percentage for compact badges, e.g. "25%". Undefined when no usable percentage exists. */
  percentOnly?: string;
  /**
   * Quota status phrase for tooltips, e.g. "25% 5-hour, resets 5:00 PM today
   * (updated 8/22/2026, 3:45:00 PM)", "Needs auth", "No usage data". Multiple
   * windows (e.g. Claude's 5-hour + 7-day, Codex's primary + secondary) join
   * with " | ", each carrying its own reset time since they reset
   * independently.
   */
  quotaPhrase: string;
}

/**
 * Normalizes a harness quota snapshot into display-ready percentage/phrase
 * strings. Last-known percentages are always shown once available, annotated
 * with the actual time they were fetched, rather than hidden — so a value is
 * still visible between Claude turns instead of disappearing every time the
 * statusline sidecar goes quiet. A window's own reset time is appended only
 * while it's still in the future; once a window's own reset has passed, that
 * timestamp would just show a reset that already happened, so it's dropped.
 */
export function getHarnessUsageDisplay(
  snapshot: HarnessUsageSnapshot | undefined,
  percentDirection: UsagePercentDirection = STATUS_LINE_USAGE_DIRECTIONS.USED,
  now: number = Date.now()
): HarnessUsageDisplay {
  if (!snapshot) {
    return { quotaPhrase: "No usage data" };
  }
  if (snapshot.quota.errorCode === HARNESS_USAGE_STATUS_CODES.AUTH_REQUIRED) {
    return { quotaPhrase: "Needs auth" };
  }
  const fetchedAt = snapshot.quota.fetchedAt;
  const windows = snapshot.quota.windows.filter(
    (window) => window.percentUsed !== undefined || window.isUnlimited === true
  );
  if (windows.length === 0) {
    return {
      quotaPhrase:
        fetchedAt !== undefined
          ? `Usage data updated ${formatTimestamp(fetchedAt)}`
          : "No usage data",
    };
  }
  const peakPercentWindow = windows.reduce<HarnessUsageWindow | undefined>(
    (peak, window) =>
      window.percentUsed !== undefined &&
      (peak?.percentUsed === undefined || window.percentUsed > peak.percentUsed)
        ? window
        : peak,
    undefined
  );
  const hasExplicitProviderQuotaDetails = windows.some(
    (window) => window.isUnlimited === true || hasFiniteQuotaTotals(window)
  );
  const quotaPhrase = windows
    .map((window) => {
      const resetPassed = window.resetAt !== undefined && now >= window.resetAt;
      const finiteTotals = hasFiniteQuotaTotals(window);
      const displayedPercent =
        window.percentUsed === undefined
          ? undefined
          : Math.round(
              formatUsagePercentForDisplay(window.percentUsed, percentDirection)
            );
      const label = window.isUnlimited
        ? "Unlimited"
        : `${displayedPercent}% ${percentDirection} ${window.label}`;
      const totals = finiteTotals
        ? ` (${formatQuotaNumber(window.used!)} / ${formatQuotaNumber(window.limit!)})`
        : "";
      const resetSuffix =
        !resetPassed && window.resetAt !== undefined
          ? `, resets ${formatFutureTime(window.resetAt, now)}`
          : "";
      return `${label}${totals}${resetSuffix}`;
    })
    .join(" | ");
  const base = hasExplicitProviderQuotaDetails
    ? `Provider quota: ${quotaPhrase}`
    : quotaPhrase;
  return {
    ...(peakPercentWindow
      ? {
          percentOnly: `${Math.round(
            formatUsagePercentForDisplay(
              peakPercentWindow.percentUsed!,
              percentDirection
            )
          )}%`,
        }
      : {}),
    quotaPhrase:
      fetchedAt !== undefined
        ? `${base} (updated ${formatTimestamp(fetchedAt)})`
        : base,
  };
}

/** The subset of a harness status the availability surfaces read. */
export type HarnessAvailabilityStatus = Pick<
  HarnessStatusInfo,
  "status" | "installCommand" | "version"
> & { available?: boolean };

/**
 * Human phrase for a harness's install/availability state. Undefined when the
 * state is unknown. A CLI below the supported minimum gets its update command
 * instead of an install command, and one below the recommended version stays
 * "Available" with the same update guidance appended.
 */
export function getHarnessAvailabilityPhrase(
  status: HarnessAvailabilityStatus | undefined
): string | undefined {
  if (!status) return undefined;
  if (status.status === HARNESS_STATUS_STRINGS.CHECKING) return "Checking…";
  const versionGuidance = formatHarnessVersionGuidance(
    "Installed version",
    status.version
  );
  if (status.available === false) {
    return (
      versionGuidance ??
      (status.installCommand
        ? formatHarnessInstallGuidance(status.installCommand)
        : "Not available")
    );
  }
  return versionGuidance ? `Available — ${versionGuidance}` : "Available";
}

/** True when the harness runs but is older than its recommended version. */
export function isHarnessVersionOutdated(
  status: HarnessAvailabilityStatus | undefined
): boolean {
  return (
    status?.available !== false &&
    status?.version?.status === HARNESS_VERSION_STATUSES.OUTDATED
  );
}

/**
 * Pipe-joined tooltip in a single fixed order — `[name] | [availability] |
 * usage` — shared by the harness dropdown rows (no name) and the footer
 * quick picker (with name), e.g. "Available | 25% 5-hour, resets 5:00 PM
 * today" or "Claude Code | Available | No usage data".
 */
export function formatHarnessUsageTooltip(
  usage: HarnessUsageDisplay,
  availabilityPhrase: string | undefined,
  name?: string
): string {
  return [name, availabilityPhrase, usage.quotaPhrase]
    .filter((part): part is string => part !== undefined)
    .join(" | ");
}
