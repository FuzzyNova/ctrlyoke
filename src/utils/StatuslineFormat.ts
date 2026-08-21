/** Closed vocabulary of fields that can appear in a customized statusline. */
export const STATUS_LINE_FIELD_IDS = {
  BRAND: "brand",
  MODEL: "model",
  CONTEXT: "context",
  USAGE: "usage",
  USAGE_1: "usage1",
  USAGE_2: "usage2",
  VERSION: "version",
  CWD: "cwd",
  SESSION_ID: "sessionId",
  BRANCH: "branch",
  DATE: "date",
  TIME: "time",
} as const;

export type StatusLineFieldId =
  (typeof STATUS_LINE_FIELD_IDS)[keyof typeof STATUS_LINE_FIELD_IDS];

/** Field metadata shared by the formatter and the format editor. */
export const STATUS_LINE_FIELD_REGISTRY = {
  [STATUS_LINE_FIELD_IDS.BRAND]: { label: "ctrlyoke ⚡" },
  [STATUS_LINE_FIELD_IDS.MODEL]: { label: "Model name" },
  [STATUS_LINE_FIELD_IDS.CONTEXT]: { label: "Context usage (colored band)" },
  [STATUS_LINE_FIELD_IDS.USAGE]: {
    label: "Rate/quota used % (worst of all windows)",
  },
  [STATUS_LINE_FIELD_IDS.USAGE_1]: {
    label: "First usage window, used % + short label",
  },
  [STATUS_LINE_FIELD_IDS.USAGE_2]: {
    label: "Second usage window, used % + short label",
  },
  [STATUS_LINE_FIELD_IDS.VERSION]: { label: "Harness/CLI version" },
  [STATUS_LINE_FIELD_IDS.CWD]: { label: "Current directory (basename)" },
  [STATUS_LINE_FIELD_IDS.SESSION_ID]: { label: "Session id (truncated)" },
  [STATUS_LINE_FIELD_IDS.BRANCH]: { label: "Git branch" },
  [STATUS_LINE_FIELD_IDS.DATE]: { label: "Date" },
  [STATUS_LINE_FIELD_IDS.TIME]: { label: "Time" },
} as const satisfies Record<StatusLineFieldId, { label: string }>;

/** ANSI prefixes for the curated statusline color vocabulary. */
export const STATUS_LINE_COLOR_IDS = {
  default: "",
  red: "\u001b[31m",
  yellow: "\u001b[33m",
  green: "\u001b[32m",
  cyan: "\u001b[36m",
  blue: "\u001b[34m",
  magenta: "\u001b[35m",
  white: "\u001b[37m",
  gray: "\u001b[90m",
} as const;

export type StatusLineColorId = keyof typeof STATUS_LINE_COLOR_IDS;

export type StatusLineSegment =
  | {
      type: "field";
      field: StatusLineFieldId;
      label?: string;
      color?: StatusLineColorId;
    }
  | {
      type: "literal";
      text: string;
      color?: StatusLineColorId;
    };

/** Shared zero-visible-change default format for both statusline providers. */
export const DEFAULT_STATUS_LINE_FORMAT = [
  { type: "field", field: STATUS_LINE_FIELD_IDS.BRAND },
  { type: "field", field: STATUS_LINE_FIELD_IDS.MODEL },
  { type: "literal", text: "·" },
  { type: "field", field: STATUS_LINE_FIELD_IDS.CONTEXT },
  { type: "literal", text: "·" },
  { type: "field", field: STATUS_LINE_FIELD_IDS.USAGE },
] satisfies readonly StatusLineSegment[];

export type UsagePercentDirection = "used" | "remaining";

const STATUS_LINE_USAGE_WINDOW_WEEK_MINUTES = 7 * 24 * 60;

/** Shared window kinds used when ordering dynamic quota tiers in a statusline. */
export const STATUS_LINE_QUOTA_WINDOW_KINDS = {
  ROLLING: "rolling",
  DAILY: "daily",
  WEEKLY: "weekly",
  MONTHLY: "monthly",
  UNKNOWN: "unknown",
} as const;

export type StatusLineQuotaWindowKind =
  (typeof STATUS_LINE_QUOTA_WINDOW_KINDS)[keyof typeof STATUS_LINE_QUOTA_WINDOW_KINDS];

/** Format a rate-limit window using the same short labels as the usage card. */
export function formatUsageWindowLabel(windowMinutes: number): string {
  if (
    windowMinutes % STATUS_LINE_USAGE_WINDOW_WEEK_MINUTES === 0 &&
    windowMinutes >= STATUS_LINE_USAGE_WINDOW_WEEK_MINUTES
  ) {
    const weeks = windowMinutes / STATUS_LINE_USAGE_WINDOW_WEEK_MINUTES;
    return weeks === 1 ? "week" : `${weeks} weeks`;
  }
  if (windowMinutes % (24 * 60) === 0) {
    const days = windowMinutes / (24 * 60);
    return days === 1 ? "day" : `${days}d`;
  }
  if (windowMinutes % 60 === 0) {
    const hours = windowMinutes / 60;
    return `${hours}h`;
  }
  return `${windowMinutes}m`;
}

/** Humanize an Antigravity quota tier using the usage card's label convention. */
export function humanizeQuotaKey(key: string): string {
  return key
    .split(/[-_\s]+/u)
    .filter((part) => part.length > 0)
    .map((part) => {
      const lower = part.toLowerCase();
      if (/^\d+p$/u.test(lower)) {
        return `${lower.slice(0, -1)}P`;
      }
      return `${lower.slice(0, 1).toUpperCase()}${lower.slice(1)}`;
    })
    .join(" ");
}

/** Classify an Antigravity quota tier for deterministic statusline ordering. */
export function quotaWindowKind(key: string): StatusLineQuotaWindowKind {
  const normalized = key.toLowerCase();
  if (normalized.includes("weekly")) {
    return STATUS_LINE_QUOTA_WINDOW_KINDS.WEEKLY;
  }
  if (normalized.includes("daily")) {
    return STATUS_LINE_QUOTA_WINDOW_KINDS.DAILY;
  }
  if (normalized.includes("monthly")) {
    return STATUS_LINE_QUOTA_WINDOW_KINDS.MONTHLY;
  }
  if (normalized.includes("rolling") || normalized.includes("hour")) {
    return STATUS_LINE_QUOTA_WINDOW_KINDS.ROLLING;
  }
  return STATUS_LINE_QUOTA_WINDOW_KINDS.UNKNOWN;
}

/** Return the fixed cadence rank used to sort dynamic quota tiers. */
export function quotaWindowKindRank(key: string): number {
  const ranks: Record<StatusLineQuotaWindowKind, number> = {
    [STATUS_LINE_QUOTA_WINDOW_KINDS.ROLLING]: 0,
    [STATUS_LINE_QUOTA_WINDOW_KINDS.DAILY]: 1,
    [STATUS_LINE_QUOTA_WINDOW_KINDS.WEEKLY]: 2,
    [STATUS_LINE_QUOTA_WINDOW_KINDS.MONTHLY]: 3,
    [STATUS_LINE_QUOTA_WINDOW_KINDS.UNKNOWN]: 4,
  };
  return ranks[quotaWindowKind(key)];
}

/** Convert a canonical used percentage into the user's display direction. */
export function formatUsagePercentForDisplay(
  usedPercent: number,
  direction: UsagePercentDirection
): number {
  return direction === "remaining" ? 100 - usedPercent : usedPercent;
}
