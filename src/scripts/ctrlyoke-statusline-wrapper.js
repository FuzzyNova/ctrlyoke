#!/usr/bin/env node

/**
 * Shared implementation for the Claude and Antigravity statusline wrappers.
 *
 * These scripts run as detached CommonJS Node processes, so this module must
 * remain standalone and depend only on Node built-ins.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const {
  DEFAULT_STATUS_LINE_FORMAT,
  STATUS_LINE_COLOR_IDS,
  STATUS_LINE_FIELD_IDS,
  STATUS_LINE_FIELD_REGISTRY,
  formatUsagePercentForDisplay,
} = require("./ctrlyoke-statusline-format.js");

// Both harnesses refresh their statusline frequently. Keep forwarding below
// the documented ~300 ms Antigravity poll cadence for a consistent contract.
const FORWARD_TIMEOUT_MS = 200;
const ANSI_RESET = "\u001b[0m";
const DEFAULT_PERCENT_DIRECTION = "used";
const STATUSLINE_SEGMENT_TYPES = Object.freeze({
  FIELD: "field",
  LITERAL: "literal",
});

const STATUSLINE_PROVIDERS = Object.freeze({
  CLAUDE: "claude",
  ANTIGRAVITY: "antigravity",
});

const DEFAULT_STATUSLINE_SETTINGS = Object.freeze({
  enabled: true,
  customCommand: "",
  useCtrlyokeStyle: true,
  format: DEFAULT_STATUS_LINE_FORMAT,
  percentDirection: DEFAULT_PERCENT_DIRECTION,
});

const CONTEXT_THRESHOLDS = Object.freeze({
  warning: 70,
  danger: 85,
});

const CONTEXT_COLORS = Object.freeze({
  neutral: "\u001b[36m",
  warning: "\u001b[33m",
  danger: "\u001b[31m",
});

let snapshotSequence = 0;

/**
 * Read the machine-scoped settings directly for every wrapper invocation.
 * This script is installed into global harness settings and can therefore be
 * launched without a ctrlyoke parent process or with an old parent
 * environment. Missing, malformed, and partial settings remain harmless.
 */
function resolveStatusLineSettings(provider, homeDirectory = os.homedir()) {
  let parsed;
  try {
    const settingsPath = path.join(homeDirectory, ".ctrlyoke", "settings.json");
    parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch {
    parsed = undefined;
  }

  const settings =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  const permissions = settings.permissions;
  const tracking =
    permissions &&
    typeof permissions === "object" &&
    !Array.isArray(permissions)
      ? permissions.statusLineTracking
      : undefined;
  const configured =
    tracking && typeof tracking === "object" && !Array.isArray(tracking)
      ? tracking[provider]
      : undefined;
  const usageTracking = settings.usageTracking;
  const percentDirection =
    usageTracking &&
    typeof usageTracking === "object" &&
    !Array.isArray(usageTracking) &&
    (usageTracking.percentDirection === "used" ||
      usageTracking.percentDirection === "remaining")
      ? usageTracking.percentDirection
      : DEFAULT_PERCENT_DIRECTION;

  const defaults = {
    ...DEFAULT_STATUSLINE_SETTINGS,
    format: cloneDefaultStatuslineFormat(),
    percentDirection,
  };

  if (
    !configured ||
    typeof configured !== "object" ||
    Array.isArray(configured)
  ) {
    return defaults;
  }

  return {
    enabled:
      typeof configured.enabled === "boolean"
        ? configured.enabled
        : DEFAULT_STATUSLINE_SETTINGS.enabled,
    customCommand:
      typeof configured.customCommand === "string"
        ? configured.customCommand
        : DEFAULT_STATUSLINE_SETTINGS.customCommand,
    useCtrlyokeStyle:
      typeof configured.useCtrlyokeStyle === "boolean"
        ? configured.useCtrlyokeStyle
        : DEFAULT_STATUSLINE_SETTINGS.useCtrlyokeStyle,
    format:
      Array.isArray(configured.format) && configured.format.length > 0
        ? configured.format
        : cloneDefaultStatuslineFormat(),
    percentDirection,
  };
}

function cloneDefaultStatuslineFormat() {
  return DEFAULT_STATUS_LINE_FORMAT.map((segment) => ({ ...segment }));
}

function asFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function normalizePayload(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

/** Parse a statusline payload without allowing malformed input to break the harness. */
function parsePayload(input) {
  try {
    return normalizePayload(JSON.parse(input.toString()));
  } catch {
    return {};
  }
}

function safeSnapshotToken(token) {
  return typeof token === "string" && token.length > 0
    ? token.replace(/[^a-zA-Z0-9._-]/g, "_")
    : undefined;
}

function buildSnapshotPayload(payload, writtenAt) {
  snapshotSequence += 1;
  return Object.assign({}, normalizePayload(payload), {
    _ctrlyoke: {
      sequence: snapshotSequence,
      writtenAt: asFiniteNumber(writtenAt) ?? Date.now(),
    },
  });
}

/**
 * Write one provider-prefixed snapshot through a same-directory temporary
 * file and rename. The provider prefix is part of the transport contract:
 * Claude uses claude-statusline-<token>.json and Antigravity uses
 * agy-statusline-<token>.json.
 */
function writeSnapshotAtomic(directory, filePrefix, token, payload, writtenAt) {
  const safeToken = safeSnapshotToken(token);
  if (
    typeof directory !== "string" ||
    directory.length === 0 ||
    typeof filePrefix !== "string" ||
    filePrefix.length === 0 ||
    !safeToken
  ) {
    return undefined;
  }

  const snapshot = buildSnapshotPayload(payload, writtenAt);
  const targetPath = path.join(directory, `${filePrefix}-${safeToken}.json`);
  const tempPath = `${targetPath}.tmp-${process.pid}-${snapshotSequence}`;

  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(tempPath, JSON.stringify(snapshot));
    fs.renameSync(tempPath, targetPath);
    return targetPath;
  } catch {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // Best-effort cleanup only.
    }
    return undefined;
  }
}

/**
 * Forward stdin bytes to a user's statusline command.
 *
 * Forwarding is best-effort. Captured stdout is returned even when the command
 * exits unsuccessfully; spawn, write, and timeout failures resolve with
 * whatever stdout was available instead of rejecting. The wrappers pass the
 * shared FORWARD_TIMEOUT_MS (200 ms) by default.
 */
function forwardToCommand(command, inputBytes, timeoutMs = FORWARD_TIMEOUT_MS) {
  if (typeof command !== "string" || command.trim().length === 0) {
    return Promise.resolve(Buffer.alloc(0));
  }

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, {
        shell: true,
        windowsHide: true,
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch {
      resolve(Buffer.alloc(0));
      return;
    }

    const output = [];
    let settled = false;
    let timer;
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(Buffer.concat(output));
    };
    timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // The wrapper remains non-fatal if the child cannot be killed.
      }
      settle();
    }, timeoutMs);

    child.stdout.on("data", (chunk) => output.push(Buffer.from(chunk)));
    child.once("error", settle);
    child.once("close", settle);
    child.stdin.on("error", settle);
    try {
      child.stdin.end(
        Buffer.isBuffer(inputBytes) ? inputBytes : Buffer.from(inputBytes)
      );
    } catch {
      settle();
    }
  });
}

function formatCompactTokenCount(value) {
  const number = asFiniteNumber(value) ?? 0;
  const absolute = Math.abs(number);
  const sign = number < 0 ? "-" : "";
  if (absolute >= 1_000_000_000) {
    return `${sign}${(absolute / 1_000_000_000).toFixed(1)}B`;
  }
  if (absolute >= 1_000_000) {
    return `${sign}${(absolute / 1_000_000).toFixed(1)}M`;
  }
  if (absolute >= 1_000) {
    return `${sign}${(absolute / 1_000).toFixed(1)}k`;
  }
  return `${Math.round(number)}`;
}

function calculateContextPercentage(used, size) {
  const safeUsed = asFiniteNumber(used);
  const safeSize = asFiniteNumber(size);
  if (safeUsed === undefined || safeSize === undefined || safeSize <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(100, (safeUsed / safeSize) * 100));
}

function getContextBand(percentage) {
  if (percentage >= CONTEXT_THRESHOLDS.danger) {
    return "danger";
  }
  if (percentage >= CONTEXT_THRESHOLDS.warning) {
    return "warning";
  }
  return "neutral";
}

function formatPercentage(percentage) {
  return `${percentage.toFixed(1).replace(/\.0$/, "")}%`;
}

function getContextValues(payload) {
  const contextWindow = normalizePayload(payload).context_window;
  const currentUsage = normalizePayload(contextWindow?.current_usage);
  const inputTokens =
    asFiniteNumber(contextWindow?.total_input_tokens) ??
    asFiniteNumber(currentUsage.input_tokens) ??
    0;
  const outputTokens =
    asFiniteNumber(contextWindow?.total_output_tokens) ??
    asFiniteNumber(currentUsage.output_tokens) ??
    0;
  const size = asFiniteNumber(contextWindow?.context_window_size) ?? 0;
  return { used: inputTokens + outputTokens, size };
}

function getQuotaPercentage(payload, provider) {
  const normalized = normalizePayload(payload);
  if (provider === STATUSLINE_PROVIDERS.CLAUDE) {
    const rateLimits = normalized.rate_limits;
    if (
      !rateLimits ||
      typeof rateLimits !== "object" ||
      Array.isArray(rateLimits)
    ) {
      return undefined;
    }
    const usedPercentages = Object.values(rateLimits)
      .map((entry) =>
        entry && typeof entry === "object"
          ? asFiniteNumber(entry.used_percentage)
          : undefined
      )
      .filter((value) => value !== undefined);
    if (usedPercentages.length === 0) {
      return undefined;
    }
    return Math.max(0, Math.min(100, Math.round(Math.max(...usedPercentages))));
  }

  const quota = normalized.quota;
  if (!quota || typeof quota !== "object" || Array.isArray(quota)) {
    return undefined;
  }
  const usedPercentages = Object.values(quota)
    .map((entry) =>
      entry && typeof entry === "object"
        ? asFiniteNumber(entry.remaining_fraction)
        : undefined
    )
    .filter((value) => value !== undefined)
    .map((value) => 100 - value * 100);
  if (usedPercentages.length === 0) {
    return undefined;
  }
  return Math.max(0, Math.min(100, Math.round(Math.max(...usedPercentages))));
}

function safeStatusLabel(value, fallback) {
  return typeof value === "string" && value.length > 0
    ? value.replace(/[\r\n]+/g, " ")
    : fallback;
}

function applySegmentColor(text, color) {
  if (
    typeof color === "string" &&
    color !== "default" &&
    Object.prototype.hasOwnProperty.call(STATUS_LINE_COLOR_IDS, color) &&
    STATUS_LINE_COLOR_IDS[color]
  ) {
    return `${STATUS_LINE_COLOR_IDS[color]}${text}${ANSI_RESET}`;
  }
  return text;
}

function renderField(field, segment, provider, context) {
  const normalized = context.normalized;
  const label = safeStatusLabel(segment.label, "");
  switch (field) {
    case STATUS_LINE_FIELD_IDS.BRAND:
      return "ctrlyoke ⚡";
    case STATUS_LINE_FIELD_IDS.MODEL: {
      const model = normalizePayload(normalized.model);
      return safeStatusLabel(
        model.id,
        typeof model.display_name === "string"
          ? model.display_name
          : "unknown-model"
      );
    }
    case STATUS_LINE_FIELD_IDS.CONTEXT: {
      const contextLabel = `${formatCompactTokenCount(context.used)}/${formatCompactTokenCount(context.size)} ${label || "ctx"} (${formatPercentage(context.percentage)})`;
      return contextLabel;
    }
    case STATUS_LINE_FIELD_IDS.USAGE: {
      const quotaPercentage = getQuotaPercentage(normalized, provider);
      const quotaLabel =
        quotaPercentage === undefined
          ? "—"
          : `${formatUsagePercentForDisplay(
              quotaPercentage,
              context.percentDirection
            )}%`;
      const usageLabel =
        label || (provider === STATUSLINE_PROVIDERS.CLAUDE ? "rate" : "quota");
      return `${usageLabel} ${quotaLabel}`;
    }
    case STATUS_LINE_FIELD_IDS.VERSION:
      return safeStatusLabel(normalized.version, "—");
    case STATUS_LINE_FIELD_IDS.CWD:
      return typeof normalized.cwd === "string" && normalized.cwd.length > 0
        ? safeStatusLabel(path.basename(normalized.cwd), "—")
        : "—";
    case STATUS_LINE_FIELD_IDS.SESSION_ID:
      return safeStatusLabel(normalized.session_id, "—").slice(0, 8);
    case STATUS_LINE_FIELD_IDS.USAGE_1:
    case STATUS_LINE_FIELD_IDS.USAGE_2:
    case STATUS_LINE_FIELD_IDS.BRANCH:
    case STATUS_LINE_FIELD_IDS.DATE:
    case STATUS_LINE_FIELD_IDS.TIME:
      // These fields are registered for the editor but are implemented by the
      // follow-up statusline phase.
      return undefined;
    default:
      return undefined;
  }
}

/** Format both providers from the shared segment vocabulary. */
function formatBrandedStatusLine(
  provider,
  payload,
  format,
  percentDirection = DEFAULT_PERCENT_DIRECTION
) {
  try {
    const normalized = normalizePayload(payload);
    const { used, size } = getContextValues(normalized);
    const percentage = calculateContextPercentage(used, size);
    const band = getContextBand(percentage);
    const segments =
      Array.isArray(format) && format.length > 0
        ? format
        : DEFAULT_STATUS_LINE_FORMAT;
    const context = {
      normalized,
      used,
      size,
      percentage,
      percentDirection:
        percentDirection === "remaining"
          ? "remaining"
          : DEFAULT_PERCENT_DIRECTION,
    };

    return segments
      .reduce((rendered, segment) => {
        if (!segment || typeof segment !== "object") {
          return rendered;
        }

        if (segment.type === STATUSLINE_SEGMENT_TYPES.LITERAL) {
          const literal = safeStatusLabel(segment.text, "");
          if (literal.length > 0) {
            rendered.push(applySegmentColor(literal, segment.color));
          }
          return rendered;
        }

        if (
          segment.type !== STATUSLINE_SEGMENT_TYPES.FIELD ||
          typeof segment.field !== "string" ||
          !Object.prototype.hasOwnProperty.call(
            STATUS_LINE_FIELD_REGISTRY,
            segment.field
          )
        ) {
          return rendered;
        }

        const fieldText = renderField(
          segment.field,
          segment,
          provider,
          context
        );
        if (fieldText === undefined || fieldText.length === 0) {
          return rendered;
        }

        const builtInColor =
          segment.field === STATUS_LINE_FIELD_IDS.CONTEXT
            ? CONTEXT_COLORS[band]
            : "";
        const text =
          typeof segment.color === "string" &&
          segment.color !== "default" &&
          Object.prototype.hasOwnProperty.call(
            STATUS_LINE_COLOR_IDS,
            segment.color
          )
            ? applySegmentColor(fieldText, segment.color)
            : builtInColor
              ? `${builtInColor}${fieldText}${ANSI_RESET}`
              : fieldText;
        rendered.push(text);
        return rendered;
      }, [])
      .join(" ");
  } catch {
    return "";
  }
}

function writeStdoutSafely(value) {
  try {
    if (value && value.length > 0) {
      process.stdout.write(value);
    }
  } catch {
    // A statusline write must never affect the harness run.
  }
}

function readStdinBytes() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    process.stdin.once("end", () => resolve(Buffer.concat(chunks)));
    process.stdin.once("error", reject);
  });
}

module.exports = {
  ANSI_RESET,
  CONTEXT_COLORS,
  CONTEXT_THRESHOLDS,
  FORWARD_TIMEOUT_MS,
  STATUSLINE_PROVIDERS,
  DEFAULT_STATUSLINE_SETTINGS,
  asFiniteNumber,
  buildSnapshotPayload,
  calculateContextPercentage,
  formatBrandedStatusLine,
  formatCompactTokenCount,
  formatUsagePercentForDisplay,
  forwardToCommand,
  getContextBand,
  getContextValues,
  getQuotaPercentage,
  normalizePayload,
  parsePayload,
  readStdinBytes,
  resolveStatusLineSettings,
  safeSnapshotToken,
  writeSnapshotAtomic,
  writeStdoutSafely,
};
