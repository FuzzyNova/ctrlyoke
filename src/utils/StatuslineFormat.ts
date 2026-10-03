// Keep this standalone statusline module dependent only on import-free leaves.
import { formatCompactTokenMagnitude } from "./CompactMagnitude";

/** Claude rate-limit payload keys paired with normalized usage-window ids. */
export const CLAUDE_RATE_LIMIT_WINDOWS = [
  { key: "five_hour", id: "five-hour", windowMinutes: 5 * 60 },
  { key: "seven_day", id: "seven-day", windowMinutes: 7 * 24 * 60 },
] as const;

/**
 * Version of the snapshot file the statusline scripts write for ctrlyoke's
 * sidecars (`_ctrlyoke.protocolVersion`). The scripts run from the shared
 * `~/.ctrlyoke/bin` launcher, which may come from a different ctrlyoke version
 * than the host reading the snapshot; a sidecar ignores any version but its
 * own, so a mismatch shows no statusline data instead of misreading it. Bump
 * only for a change an older reader would misinterpret.
 */
export const STATUSLINE_SNAPSHOT_PROTOCOL_VERSION = 1;

/** Closed vocabulary of fields that can appear in a customized statusline. */
export const STATUS_LINE_FIELD_IDS = {
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

export const STATUS_LINE_FORMAT_SEGMENT_TYPES = {
  FIELD: "field",
  LITERAL: "literal",
} as const;

export const STATUS_LINE_USAGE_DIRECTIONS = {
  USED: "used",
  REMAINING: "remaining",
} as const;

export const STATUS_LINE_COLOR_NAMES = {
  DEFAULT: "default",
} as const;

/** Field metadata shared by the formatter and the format editor. */
export const STATUS_LINE_FIELD_REGISTRY = {
  [STATUS_LINE_FIELD_IDS.MODEL]: {
    label: "Model",
    labelSlot: false,
    description: undefined,
  },
  [STATUS_LINE_FIELD_IDS.CONTEXT]: {
    label: "Context usage",
    labelSlot: true,
    description:
      "Token usage against the context window. Auto-colors as it approaches the limit.",
  },
  [STATUS_LINE_FIELD_IDS.USAGE]: {
    label: "Peak usage %",
    labelSlot: true,
    description:
      "The most-used rate/quota window, so you always see whichever one is closest to its limit.",
  },
  [STATUS_LINE_FIELD_IDS.USAGE_1]: {
    label: "Usage window 1",
    labelSlot: true,
    description: "The first rate/quota window's used % and short label.",
  },
  [STATUS_LINE_FIELD_IDS.USAGE_2]: {
    label: "Usage window 2",
    labelSlot: true,
    description: "The second rate/quota window's used % and short label.",
  },
  [STATUS_LINE_FIELD_IDS.VERSION]: {
    label: "CLI version",
    labelSlot: false,
    description: undefined,
  },
  [STATUS_LINE_FIELD_IDS.CWD]: {
    label: "Directory",
    labelSlot: false,
    description: "Current working directory (basename only).",
  },
  [STATUS_LINE_FIELD_IDS.SESSION_ID]: {
    label: "Session ID",
    labelSlot: false,
    description: "Truncated session id.",
  },
  [STATUS_LINE_FIELD_IDS.BRANCH]: {
    label: "Git branch",
    labelSlot: false,
    description: undefined,
  },
  [STATUS_LINE_FIELD_IDS.DATE]: {
    label: "Date",
    labelSlot: false,
    description: undefined,
  },
  [STATUS_LINE_FIELD_IDS.TIME]: {
    label: "Time",
    labelSlot: false,
    description: undefined,
  },
} as const satisfies Record<
  StatusLineFieldId,
  { label: string; labelSlot: boolean; description?: string }
>;

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

/** Browser-friendly swatch colours for the closed terminal colour vocabulary. */
export const STATUS_LINE_COLOR_SWATCHES: Record<StatusLineColorId, string> = {
  default: "var(--vscode-foreground, currentColor)",
  red: "#f14c4c",
  yellow: "#cca700",
  green: "#89d185",
  cyan: "#29b8db",
  blue: "#3794ff",
  magenta: "#bc3fbc",
  white: "#ffffff",
  gray: "#808080",
};

export type StatusLineSegment =
  | {
      type: typeof STATUS_LINE_FORMAT_SEGMENT_TYPES.FIELD;
      field: StatusLineFieldId;
      label?: string;
      color?: StatusLineColorId;
    }
  | {
      type: typeof STATUS_LINE_FORMAT_SEGMENT_TYPES.LITERAL;
      text: string;
      color?: StatusLineColorId;
    };

/**
 * Shared default format for both statusline providers. The leading brand
 * segment is a plain literal (not a field) so it renders as an editable text
 * box from the start, hinting that it can be customized in place.
 */
export const DEFAULT_STATUS_LINE_FORMAT = [
  { type: STATUS_LINE_FORMAT_SEGMENT_TYPES.LITERAL, text: "ctrlyoke" },
  {
    type: STATUS_LINE_FORMAT_SEGMENT_TYPES.FIELD,
    field: STATUS_LINE_FIELD_IDS.MODEL,
  },
  { type: STATUS_LINE_FORMAT_SEGMENT_TYPES.LITERAL, text: "·" },
  {
    type: STATUS_LINE_FORMAT_SEGMENT_TYPES.FIELD,
    field: STATUS_LINE_FIELD_IDS.CONTEXT,
  },
  { type: STATUS_LINE_FORMAT_SEGMENT_TYPES.LITERAL, text: "·" },
  {
    type: STATUS_LINE_FORMAT_SEGMENT_TYPES.FIELD,
    field: STATUS_LINE_FIELD_IDS.USAGE,
  },
] satisfies readonly StatusLineSegment[];

/** Return whether a format has the same ordered segments and values as the default. */
export function isDefaultStatusLineFormat(
  format: StatusLineSegment[]
): boolean {
  if (format.length !== DEFAULT_STATUS_LINE_FORMAT.length) {
    return false;
  }

  return format.every((segment, index) => {
    const defaultSegment: StatusLineSegment = DEFAULT_STATUS_LINE_FORMAT[index];
    if (segment.type !== defaultSegment.type) {
      return false;
    }

    if (
      segment.type === STATUS_LINE_FORMAT_SEGMENT_TYPES.FIELD &&
      defaultSegment.type === STATUS_LINE_FORMAT_SEGMENT_TYPES.FIELD
    ) {
      return (
        segment.field === defaultSegment.field &&
        segment.label === defaultSegment.label &&
        segment.color === defaultSegment.color
      );
    }

    if (
      segment.type === STATUS_LINE_FORMAT_SEGMENT_TYPES.LITERAL &&
      defaultSegment.type === STATUS_LINE_FORMAT_SEGMENT_TYPES.LITERAL
    ) {
      return (
        segment.text === defaultSegment.text &&
        segment.color === defaultSegment.color
      );
    }

    return false;
  });
}

export type UsagePercentDirection =
  (typeof STATUS_LINE_USAGE_DIRECTIONS)[keyof typeof STATUS_LINE_USAGE_DIRECTIONS];

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
      if (lower === "3p") {
        return "3rd Party";
      }
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
  return direction === STATUS_LINE_USAGE_DIRECTIONS.REMAINING
    ? 100 - usedPercent
    : usedPercent;
}

export const STATUS_LINE_FORMAT_PROVIDERS = {
  CLAUDE: "claude",
  ANTIGRAVITY: "antigravity",
  COPILOT: "copilot",
  QWEN: "qwen",
} as const;

export type StatusLineFormatProvider =
  (typeof STATUS_LINE_FORMAT_PROVIDERS)[keyof typeof STATUS_LINE_FORMAT_PROVIDERS];

export interface StatusLineFormatOptions {
  /** Locally computed fields are supplied by the detached wrapper when available. */
  branch?: string;
  now?: Date;
}

const STATUS_LINE_CONTEXT_THRESHOLDS = {
  WARNING: 70,
  DANGER: 85,
} as const;

const STATUS_LINE_CONTEXT_BANDS = {
  NEUTRAL: "neutral",
  WARNING: "warning",
  DANGER: "danger",
} as const;

type StatusLineContextBand =
  (typeof STATUS_LINE_CONTEXT_BANDS)[keyof typeof STATUS_LINE_CONTEXT_BANDS];

const ANSI_RESET = "\u001b[0m";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function safeLabel(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0
    ? value.replace(/[\r\n]+/gu, " ")
    : fallback;
}

/** Resolve the workspace directory represented by a provider statusline payload. */
export function getStatusLineWorkspaceDirectory(
  payload: unknown
): string | undefined {
  if (!isRecord(payload)) return undefined;
  if (typeof payload.cwd === "string" && payload.cwd.length > 0) {
    return payload.cwd;
  }
  const workspace = isRecord(payload.workspace) ? payload.workspace : {};
  return typeof workspace.current_dir === "string" &&
    workspace.current_dir.length > 0
    ? workspace.current_dir
    : undefined;
}

function compactTokenCount(value: unknown): string {
  const number = finiteNumber(value) ?? 0;
  const absolute = Math.abs(number);
  const sign = number < 0 ? "-" : "";
  if (absolute >= 1_000) {
    return `${sign}${formatCompactTokenMagnitude(absolute)}`;
  }
  return `${Math.round(number)}`;
}

function contextValues(
  payload: Record<string, unknown>,
  provider: StatusLineFormatProvider
): {
  used: number;
  size: number;
} {
  const contextWindow = isRecord(payload.context_window)
    ? payload.context_window
    : {};
  const size = finiteNumber(contextWindow.context_window_size);
  if (provider === STATUS_LINE_FORMAT_PROVIDERS.COPILOT) {
    const used = finiteNumber(contextWindow.current_context_tokens);
    const displayedSize = finiteNumber(contextWindow.displayed_context_limit);
    if (used !== undefined && displayedSize !== undefined) {
      return { used, size: displayedSize };
    }
  }
  if (provider === STATUS_LINE_FORMAT_PROVIDERS.QWEN) {
    const used = finiteNumber(contextWindow.current_usage);
    if (used !== undefined && size !== undefined) {
      return { used, size };
    }
  }
  const currentUsage = isRecord(contextWindow.current_usage)
    ? contextWindow.current_usage
    : {};
  const input =
    finiteNumber(contextWindow.total_input_tokens) ??
    finiteNumber(currentUsage.input_tokens) ??
    0;
  const output =
    finiteNumber(contextWindow.total_output_tokens) ??
    finiteNumber(currentUsage.output_tokens) ??
    0;
  return {
    used: input + output,
    size: size ?? 0,
  };
}

function contextPercentage(used: number, size: number): number {
  if (!Number.isFinite(used) || !Number.isFinite(size) || size <= 0) return 0;
  return Math.max(0, Math.min(100, (used / size) * 100));
}

function contextBand(percentage: number): StatusLineContextBand {
  if (percentage >= STATUS_LINE_CONTEXT_THRESHOLDS.DANGER) {
    return STATUS_LINE_CONTEXT_BANDS.DANGER;
  }
  if (percentage >= STATUS_LINE_CONTEXT_THRESHOLDS.WARNING) {
    return STATUS_LINE_CONTEXT_BANDS.WARNING;
  }
  return STATUS_LINE_CONTEXT_BANDS.NEUTRAL;
}

function percentageLabel(percentage: number): string {
  return `${percentage.toFixed(1).replace(/\.0$/u, "")}%`;
}

function quotaPercentage(
  payload: Record<string, unknown>,
  provider: StatusLineFormatProvider
): number | undefined {
  const source = quotaSource(payload, provider);
  if (!isRecord(source)) return undefined;

  const percentages = Object.values(source)
    .map((entry) => {
      if (!isRecord(entry)) return undefined;
      if (provider === STATUS_LINE_FORMAT_PROVIDERS.CLAUDE) {
        return finiteNumber(entry.used_percentage);
      }
      const remaining = finiteNumber(entry.remaining_fraction);
      return remaining === undefined ? undefined : 100 - remaining * 100;
    })
    .filter((value): value is number => value !== undefined);
  return percentages.length > 0
    ? Math.max(0, Math.min(100, Math.round(Math.max(...percentages))))
    : undefined;
}

function normalizeUsedPercentage(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function usageWindows(
  payload: Record<string, unknown>,
  provider: StatusLineFormatProvider
): Array<{ id?: string; label: string; usedPercentage: number } | undefined> {
  const source = quotaSource(payload, provider);
  if (!isRecord(source)) return [];

  if (provider === STATUS_LINE_FORMAT_PROVIDERS.CLAUDE) {
    return CLAUDE_RATE_LIMIT_WINDOWS.map((definition) => {
      const entry = source[definition.key];
      const value = isRecord(entry)
        ? finiteNumber(entry.used_percentage)
        : undefined;
      return value === undefined
        ? undefined
        : {
            label: formatUsageWindowLabel(definition.windowMinutes),
            usedPercentage: normalizeUsedPercentage(value),
          };
    });
  }

  return Object.entries(source)
    .filter(([, entry]) => isRecord(entry))
    .map(([id, entry]) => {
      const remaining = finiteNumber(
        isRecord(entry) ? entry.remaining_fraction : undefined
      );
      return {
        id,
        label: humanizeQuotaKey(id),
        usedPercentage:
          remaining === undefined
            ? Number.NaN
            : normalizeUsedPercentage(100 - remaining * 100),
      };
    })
    .filter((window) => Number.isFinite(window.usedPercentage))
    .sort(
      (left, right) =>
        quotaWindowKindRank(left.id ?? "") -
          quotaWindowKindRank(right.id ?? "") ||
        (left.id ?? "").localeCompare(right.id ?? "")
    );
}

function quotaSource(
  payload: Record<string, unknown>,
  provider: StatusLineFormatProvider
): unknown {
  switch (provider) {
    case STATUS_LINE_FORMAT_PROVIDERS.CLAUDE:
      return payload.rate_limits;
    case STATUS_LINE_FORMAT_PROVIDERS.ANTIGRAVITY:
      return payload.quota;
    case STATUS_LINE_FORMAT_PROVIDERS.COPILOT:
    case STATUS_LINE_FORMAT_PROVIDERS.QWEN:
      return undefined;
  }
}

function basename(value: string): string {
  const parts = value.split(/[\\/]/u);
  return parts[parts.length - 1] ?? value;
}

function applyColor(text: string, color: unknown): string {
  if (
    typeof color === "string" &&
    color !== STATUS_LINE_COLOR_NAMES.DEFAULT &&
    Object.prototype.hasOwnProperty.call(STATUS_LINE_COLOR_IDS, color)
  ) {
    const ansi = STATUS_LINE_COLOR_IDS[color as StatusLineColorId];
    return ansi ? `${ansi}${text}${ANSI_RESET}` : text;
  }
  return text;
}

function isStatusLineColor(value: unknown): value is StatusLineColorId {
  return (
    typeof value === "string" &&
    value !== STATUS_LINE_COLOR_NAMES.DEFAULT &&
    Object.prototype.hasOwnProperty.call(STATUS_LINE_COLOR_IDS, value)
  );
}

/** Reverse lookup from an ANSI SGR code (e.g. "31") to its statusline color id. */
const ANSI_COLOR_ID_BY_CODE: Record<string, StatusLineColorId> =
  Object.fromEntries(
    Object.entries(STATUS_LINE_COLOR_IDS)
      .filter(([id]) => id !== STATUS_LINE_COLOR_NAMES.DEFAULT)
      .map(([id, ansi]) => [
        /\[(\d+)m/u.exec(ansi)?.[1] ?? "",
        id as StatusLineColorId,
      ])
  );

const ANSI_SGR_PATTERN = /\[(\d+)m/gu;

export interface AnsiStatusLineChunk {
  text: string;
  color?: StatusLineColorId;
}

/**
 * Split a statusline string containing ANSI SGR color codes (as produced by
 * `formatBrandedStatusLine`) into plain-text chunks tagged with the
 * statusline color id in effect, for rendering outside a real terminal
 * (e.g. the webview preview).
 */
export function parseAnsiStatusLine(text: string): AnsiStatusLineChunk[] {
  const chunks: AnsiStatusLineChunk[] = [];
  let currentColor: StatusLineColorId | undefined;
  let lastIndex = 0;
  ANSI_SGR_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ANSI_SGR_PATTERN.exec(text)) !== null) {
    if (match.index > lastIndex) {
      chunks.push({
        text: text.slice(lastIndex, match.index),
        color: currentColor,
      });
    }
    const code = match[1];
    currentColor = code === "0" ? undefined : ANSI_COLOR_ID_BY_CODE[code];
    lastIndex = ANSI_SGR_PATTERN.lastIndex;
  }
  if (lastIndex < text.length) {
    chunks.push({ text: text.slice(lastIndex), color: currentColor });
  }
  return chunks.filter((chunk) => chunk.text.length > 0);
}

/** Format statusline segments for both the detached wrapper and the webview preview. */
export function formatBrandedStatusLine(
  provider: StatusLineFormatProvider,
  payload: unknown,
  format?: readonly StatusLineSegment[],
  percentDirection: UsagePercentDirection = STATUS_LINE_USAGE_DIRECTIONS.USED,
  options: StatusLineFormatOptions = {}
): string {
  try {
    const normalized = isRecord(payload) ? payload : {};
    const { used, size } = contextValues(normalized, provider);
    const percentage = contextPercentage(used, size);
    const band = contextBand(percentage);
    const segments: readonly StatusLineSegment[] =
      format && format.length > 0 ? format : DEFAULT_STATUS_LINE_FORMAT;
    const windows = usageWindows(normalized, provider);
    const direction =
      percentDirection === STATUS_LINE_USAGE_DIRECTIONS.REMAINING
        ? STATUS_LINE_USAGE_DIRECTIONS.REMAINING
        : STATUS_LINE_USAGE_DIRECTIONS.USED;
    const now = options.now ?? new Date();
    const rendered: Array<{
      type: StatusLineSegment["type"];
      text: string;
    }> = [];

    for (const segment of segments) {
      if (!isRecord(segment)) continue;
      let text: string | undefined;
      let isRecognizedField = false;
      if (segment.type === STATUS_LINE_FORMAT_SEGMENT_TYPES.LITERAL) {
        const literal = safeLabel(segment.text, "");
        text =
          literal.length > 0 ? applyColor(literal, segment.color) : undefined;
        if (text !== undefined) {
          rendered.push({
            type: STATUS_LINE_FORMAT_SEGMENT_TYPES.LITERAL,
            text,
          });
        }
      } else if (
        segment.type === STATUS_LINE_FORMAT_SEGMENT_TYPES.FIELD &&
        typeof segment.field === "string" &&
        Object.prototype.hasOwnProperty.call(
          STATUS_LINE_FIELD_REGISTRY,
          segment.field
        )
      ) {
        isRecognizedField = true;
        const field = segment.field as StatusLineFieldId;
        const label = safeLabel(segment.label, "");
        switch (field) {
          case STATUS_LINE_FIELD_IDS.MODEL: {
            const model = isRecord(normalized.model) ? normalized.model : {};
            text = safeLabel(
              model.id,
              safeLabel(model.display_name, "unknown-model")
            );
            break;
          }
          case STATUS_LINE_FIELD_IDS.CONTEXT:
            text = `${compactTokenCount(used)}/${compactTokenCount(size)} ${label || "ctx"} (${percentageLabel(percentage)})`;
            break;
          case STATUS_LINE_FIELD_IDS.USAGE: {
            const value = quotaPercentage(normalized, provider);
            const display =
              value === undefined
                ? "—"
                : `${formatUsagePercentForDisplay(value, direction)}%`;
            text = `${label || (provider === STATUS_LINE_FORMAT_PROVIDERS.CLAUDE ? "rate" : "quota")} ${display}`;
            break;
          }
          case STATUS_LINE_FIELD_IDS.USAGE_1:
          case STATUS_LINE_FIELD_IDS.USAGE_2: {
            const window =
              windows[field === STATUS_LINE_FIELD_IDS.USAGE_1 ? 0 : 1];
            if (window) {
              text = `${label || window.label} ${formatUsagePercentForDisplay(window.usedPercentage, direction)}%`;
            }
            break;
          }
          case STATUS_LINE_FIELD_IDS.VERSION:
            text = safeLabel(normalized.version, "—");
            break;
          case STATUS_LINE_FIELD_IDS.CWD:
            {
              const cwd = getStatusLineWorkspaceDirectory(normalized);
              text = safeLabel(cwd ? basename(cwd) : undefined, "—");
            }
            break;
          case STATUS_LINE_FIELD_IDS.SESSION_ID:
            text = safeLabel(normalized.session_id, "—").slice(0, 8);
            break;
          case STATUS_LINE_FIELD_IDS.BRANCH:
            text = options.branch;
            break;
          case STATUS_LINE_FIELD_IDS.DATE:
            text = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
            break;
          case STATUS_LINE_FIELD_IDS.TIME:
            text = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
            break;
        }
        if (text !== undefined) {
          const explicitColor = isStatusLineColor(segment.color);
          text = explicitColor
            ? applyColor(text, segment.color)
            : field === STATUS_LINE_FIELD_IDS.CONTEXT
              ? applyColor(
                  text,
                  band === STATUS_LINE_CONTEXT_BANDS.DANGER
                    ? "red"
                    : band === STATUS_LINE_CONTEXT_BANDS.WARNING
                      ? "yellow"
                      : "cyan"
                )
              : text;
        }
      }
      if (isRecognizedField) {
        rendered.push({
          type: STATUS_LINE_FORMAT_SEGMENT_TYPES.FIELD,
          text: text ?? "",
        });
      }
    }

    const formatted: string[] = [];
    // Keep outer literal runs as written; inside field gaps, use only the run
    // nearest the next non-empty field.
    const literalRuns: string[][] = [];
    let currentLiteralRun: string[] = [];
    let hasField = false;
    let hasNonEmptyField = false;

    for (const segment of rendered) {
      if (segment.type === STATUS_LINE_FORMAT_SEGMENT_TYPES.LITERAL) {
        currentLiteralRun.push(segment.text);
        continue;
      }

      if (currentLiteralRun.length > 0) {
        if (hasField) {
          literalRuns.push(currentLiteralRun);
        } else {
          formatted.push(...currentLiteralRun);
        }
        currentLiteralRun = [];
      }

      hasField = true;
      if (segment.text.length === 0) continue;

      if (hasNonEmptyField) {
        const separatorRun = literalRuns[literalRuns.length - 1];
        if (separatorRun) formatted.push(...separatorRun);
      }
      formatted.push(segment.text);
      hasNonEmptyField = true;
      literalRuns.length = 0;
    }

    if (currentLiteralRun.length > 0) {
      formatted.push(...currentLiteralRun);
    }

    if (!hasField) {
      return rendered
        .filter((segment) => segment.text.length > 0)
        .map((segment) => segment.text)
        .join(" ");
    }

    return formatted.join(" ");
  } catch {
    return "";
  }
}
