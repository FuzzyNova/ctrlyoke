import { HARNESS_USAGE_STATUS_CODES } from "@root/types/DashboardConstants";
import {
  isHarnessQuotaStale,
  isHarnessUsageWindowStale,
  type HarnessUsageSnapshot,
} from "@root/types/UsageTypes";
import { HARNESS_STATUS_STRINGS, type HarnessStatusString } from "../types/messages";

export interface HarnessUsageDisplay {
  /** Bare percentage for compact badges, e.g. "25%". Undefined when no usable percentage exists. */
  percentOnly?: string;
  /** Quota status phrase for tooltips, e.g. "25% 5-hour", "Needs auth", "Usage data stale", "No usage data". */
  quotaPhrase: string;
}

/**
 * Normalizes a harness quota snapshot into display-ready percentage/phrase
 * strings. Last-known percentages are always shown once available — a window
 * past its freshness window or its own reset time is annotated "(stale)"
 * rather than hidden, so a value is still visible between Claude turns
 * instead of disappearing every time the statusline sidecar goes quiet.
 */
export function getHarnessUsageDisplay(
  snapshot: HarnessUsageSnapshot | undefined,
  now: number = Date.now()
): HarnessUsageDisplay {
  if (!snapshot) {
    return { quotaPhrase: "No usage data" };
  }
  if (snapshot.quota.errorCode === HARNESS_USAGE_STATUS_CODES.AUTH_REQUIRED) {
    return { quotaPhrase: "Needs auth" };
  }
  const windows = snapshot.quota.windows.filter(
    (window) => window.percentUsed !== undefined
  );
  if (windows.length === 0) {
    return {
      quotaPhrase: isHarnessQuotaStale(snapshot.quota, now)
        ? "Usage data stale"
        : "No usage data",
    };
  }
  const primaryPercent = Math.round(windows[0].percentUsed ?? 0);
  return {
    percentOnly: `${primaryPercent}%`,
    quotaPhrase: windows
      .map((window) => {
        const label = `${Math.round(window.percentUsed ?? 0)}% ${window.label}`;
        return isHarnessUsageWindowStale(snapshot.quota, window, now)
          ? `${label} (stale)`
          : label;
      })
      .join(" | "),
  };
}

export interface HarnessAvailabilityStatus {
  status: HarnessStatusString;
  available?: boolean;
  installHint?: string;
}

/** Human phrase for a harness's install/availability state. Undefined when the state is unknown. */
export function getHarnessAvailabilityPhrase(
  status: HarnessAvailabilityStatus | undefined
): string | undefined {
  if (!status) return undefined;
  if (status.status === HARNESS_STATUS_STRINGS.CHECKING) return "Checking…";
  if (status.available === false) return status.installHint ?? "Not available";
  return "Available";
}

/**
 * Pipe-joined tooltip in a single fixed order — `[name] | [availability] |
 * usage` — shared by the harness dropdown rows (no name) and the footer
 * quick picker (with name), e.g. "Available | 25% 5-hour" or
 * "Claude Code | Available | No usage data".
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
