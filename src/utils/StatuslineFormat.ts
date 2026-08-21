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

/** Convert a canonical used percentage into the user's display direction. */
export function formatUsagePercentForDisplay(
  usedPercent: number,
  direction: UsagePercentDirection
): number {
  return direction === "remaining" ? 100 - usedPercent : usedPercent;
}
