#!/usr/bin/env node

/**
 * ctrlyoke Antigravity statusline wrapper.
 *
 * agy invokes this script as:
 *
 *   node <absolute-script-path>
 *
 * The wrapper takes no positional arguments because agy splits its command on
 * whitespace without shell quote processing. The provider supplies:
 *   CTRLYOKE_AGY_STATUSLINE_TOKEN   Correlation token for the snapshot file.
 *   CTRLYOKE_AGY_STATUSLINE_DIR     Absolute .ctrlyoke/temp directory.
 *   CTRLYOKE_AGY_STATUSLINE_FORWARD Optional full baseline command to forward.
 *
 * The forward command is intentionally an environment variable: unlike an
 * argv element, it can contain spaces and is executed with shell semantics so
 * existing user statusline commands keep working.
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const FORWARD_TIMEOUT_MS = 200;
const ANSI_RESET = "\u001b[0m";

// Keep these in sync with WorkflowStep.tsx's context bar: neutral < 70% /
// warning >= 70% / danger >= 85%. That component is currently the source of
// truth for the webview thresholds; this script must remain standalone.
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

/**
 * Parse agy's stdin payload without allowing malformed input to break the
 * visible statusline.
 *
 * @param {string|Buffer} input
 * @returns {object}
 */
function parsePayload(input) {
  try {
    return normalizePayload(JSON.parse(input.toString()));
  } catch {
    return {};
  }
}

/**
 * Add watcher metadata while retaining agy's payload fields at the top level.
 *
 * @param {object} payload
 * @param {number} writtenAt
 * @returns {object}
 */
function buildSnapshotPayload(payload, writtenAt) {
  snapshotSequence += 1;
  return Object.assign({}, normalizePayload(payload), {
    _ctrlyoke: {
      sequence: snapshotSequence,
      writtenAt,
    },
  });
}

function safeSnapshotToken(token) {
  return typeof token === "string" && token.length > 0
    ? token.replace(/[^a-zA-Z0-9._-]/g, "_")
    : undefined;
}

/**
 * Publish a snapshot with a same-directory temp file and rename. All errors
 * are swallowed because a statusline write must never affect agy's run.
 *
 * @param {string|undefined} directory
 * @param {string|undefined} token
 * @param {object} payload
 * @param {number} [writtenAt]
 * @returns {string|undefined} Published path, when the write succeeded.
 */
function writeSnapshot(directory, token, payload, writtenAt) {
  const safeToken = safeSnapshotToken(token);
  if (typeof directory !== "string" || directory.length === 0 || !safeToken) {
    return undefined;
  }

  const timestamp = writtenAt ?? Date.now();
  const snapshot = buildSnapshotPayload(payload, timestamp);
  const targetPath = path.join(directory, `agy-statusline-${safeToken}.json`);
  const tempPath = `${targetPath}.tmp-${process.pid}-${snapshot._ctrlyoke.sequence}`;

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
  const inputTokens = asFiniteNumber(contextWindow?.total_input_tokens) ?? 0;
  const outputTokens = asFiniteNumber(contextWindow?.total_output_tokens) ?? 0;
  const size = asFiniteNumber(contextWindow?.context_window_size) ?? 0;
  const used = inputTokens + outputTokens;
  return { used, size };
}

function getQuotaPercentage(payload) {
  const quota = normalizePayload(payload).quota;
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

function writeStdoutSafely(value) {
  try {
    process.stdout.write(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Format ctrlyoke's branded fallback statusline.
 *
 * @param {object} payload
 * @returns {string}
 */
function formatBrandedStatusLine(payload) {
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
  const quotaPercentage = getQuotaPercentage(normalized);
  const quotaLabel =
    quotaPercentage === undefined ? "—" : `${quotaPercentage}%`;
  const contextLabel = `${formatCompactTokenCount(used)}/${formatCompactTokenCount(size)} ctx (${formatPercentage(percentage)})`;

  return [
    "ctrlyoke ⚡",
    modelLabel,
    "·",
    `${CONTEXT_COLORS[band]}${contextLabel}${ANSI_RESET}`,
    "·",
    `quota ${quotaLabel}`,
    "·",
    agentState,
  ].join(" ");
}

function readStdinBytes() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    process.stdin.once("end", () => resolve(Buffer.concat(chunks)));
    process.stdin.once("error", reject);
  });
}

/**
 * Forward the original stdin bytes to a baseline statusline command. The
 * result is true only when the command exits successfully before the timeout.
 *
 * @param {string} command
 * @param {Buffer} input
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
function forwardBaseline(command, input, timeoutMs = FORWARD_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, {
        shell: true,
        windowsHide: true,
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch {
      resolve(false);
      return;
    }

    const output = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        // The fallback still needs to render if the child cannot be killed.
      }
      resolve(false);
    }, timeoutMs);

    const finish = (success) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (success) {
        success = writeStdoutSafely(Buffer.concat(output));
      }
      resolve(success);
    };

    child.stdout.on("data", (chunk) => output.push(Buffer.from(chunk)));
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0));
    child.stdin.on("error", () => finish(false));
    child.stdin.end(input);
  });
}

async function runStatusline(input, env = process.env) {
  const payload = parsePayload(input);
  writeSnapshot(
    env.CTRLYOKE_AGY_STATUSLINE_DIR,
    env.CTRLYOKE_AGY_STATUSLINE_TOKEN,
    payload
  );

  const forwardCommand = env.CTRLYOKE_AGY_STATUSLINE_FORWARD;
  if (typeof forwardCommand === "string" && forwardCommand.trim().length > 0) {
    if (
      await forwardBaseline(
        forwardCommand,
        Buffer.isBuffer(input) ? input : Buffer.from(input)
      )
    ) {
      return;
    }
  }

  writeStdoutSafely(formatBrandedStatusLine(payload));
}

function main() {
  readStdinBytes()
    .then((input) => runStatusline(input))
    .catch(() => {
      try {
        writeStdoutSafely(formatBrandedStatusLine({}));
      } catch {
        // Exit successfully even if stdout itself is unavailable.
      }
    })
    .finally(() => {
      process.exitCode = 0;
    });
}

if (require.main === module) {
  main();
}

module.exports = {
  parsePayload,
  buildSnapshotPayload,
  writeSnapshot,
  formatCompactTokenCount,
  calculateContextPercentage,
  getContextBand,
  formatBrandedStatusLine,
  forwardBaseline,
  runStatusline,
};
