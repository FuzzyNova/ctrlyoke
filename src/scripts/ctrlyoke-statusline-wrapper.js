#!/usr/bin/env node

/**
 * Shared implementation for the Claude and Antigravity statusline wrappers.
 *
 * These scripts run as detached CommonJS Node processes, so this module must
 * remain standalone and depend only on Node built-ins.
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

// Both harnesses refresh their statusline frequently. Keep forwarding below
// the documented ~300 ms Antigravity poll cadence for a consistent contract.
const FORWARD_TIMEOUT_MS = 200;
const ANSI_RESET = "\u001b[0m";

const STATUSLINE_PROVIDERS = Object.freeze({
  CLAUDE: "claude",
  ANTIGRAVITY: "antigravity",
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
    const remainingPercentages = Object.values(rateLimits)
      .map((entry) =>
        entry && typeof entry === "object"
          ? asFiniteNumber(entry.used_percentage)
          : undefined
      )
      .filter((value) => value !== undefined)
      .map((value) => 100 - value);
    if (remainingPercentages.length === 0) {
      return undefined;
    }
    return Math.max(
      0,
      Math.min(100, Math.round(Math.min(...remainingPercentages)))
    );
  }

  const quota = normalized.quota;
  if (!quota || typeof quota !== "object" || Array.isArray(quota)) {
    return undefined;
  }
  const remainingFractions = Object.values(quota)
    .map((entry) =>
      entry && typeof entry === "object"
        ? asFiniteNumber(entry.remaining_fraction)
        : undefined
    )
    .filter((value) => value !== undefined);
  if (remainingFractions.length === 0) {
    return undefined;
  }
  return Math.max(
    0,
    Math.min(100, Math.round(Math.min(...remainingFractions) * 100))
  );
}

function safeStatusLabel(value, fallback) {
  return typeof value === "string" && value.length > 0
    ? value.replace(/[\r\n]+/g, " ")
    : fallback;
}

/** Format both providers using one branded statusline shape. */
function formatBrandedStatusLine(providerOrPayload, payloadOrProvider) {
  // Preserve the old one-argument Antigravity call shape for existing callers.
  const provider =
    typeof providerOrPayload === "string"
      ? providerOrPayload
      : typeof payloadOrProvider === "string"
        ? payloadOrProvider
        : STATUSLINE_PROVIDERS.ANTIGRAVITY;
  const payload =
    typeof providerOrPayload === "string"
      ? payloadOrProvider
      : providerOrPayload;
  const normalized = normalizePayload(payload);
  const model = normalizePayload(normalized.model);
  const modelLabel = safeStatusLabel(
    model.id,
    model.display_name ?? "unknown-model"
  );
  const agentState = safeStatusLabel(normalized.agent_state, "unknown");
  const { used, size } = getContextValues(normalized);
  const percentage = calculateContextPercentage(used, size);
  const band = getContextBand(percentage);
  const quotaPercentage = getQuotaPercentage(normalized, provider);
  const quotaLabel =
    quotaPercentage === undefined ? "—" : `${quotaPercentage}%`;
  const contextLabel = `${formatCompactTokenCount(used)}/${formatCompactTokenCount(size)} ctx (${formatPercentage(percentage)})`;

  return [
    "ctrlyoke ⚡",
    modelLabel,
    "·",
    `${CONTEXT_COLORS[band]}${contextLabel}${ANSI_RESET}`,
    "·",
    provider === STATUSLINE_PROVIDERS.CLAUDE
      ? `rate ${quotaLabel}`
      : `quota ${quotaLabel}`,
    "·",
    agentState,
  ].join(" ");
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
  asFiniteNumber,
  buildSnapshotPayload,
  calculateContextPercentage,
  formatBrandedStatusLine,
  formatCompactTokenCount,
  forwardToCommand,
  getContextBand,
  getContextValues,
  getQuotaPercentage,
  normalizePayload,
  parsePayload,
  readStdinBytes,
  safeSnapshotToken,
  writeSnapshotAtomic,
  writeStdoutSafely,
};
