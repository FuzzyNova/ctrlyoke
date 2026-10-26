#!/usr/bin/env node

/**
 * Shared implementation for the supported statusline wrappers.
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
  STATUSLINE_SNAPSHOT_PROTOCOL_VERSION,
  getStatusLineWorkspaceDirectory,
  formatUsagePercentForDisplay,
  formatBrandedStatusLine: formatSharedBrandedStatusLine,
} = require("./ctrlyoke-statusline-format.js");
const {
  migrateToCurrent,
  CURRENT_SCHEMA_VERSIONS,
  PERSISTED_STORES,
} = require("./ctrlyoke-format-migrations.js");

const DEFAULT_FORWARD_TIMEOUT_MS = 1500;

/**
 * The forward budget, overridable through the environment.
 *
 * The environment override lets tests exercise timeout behavior without
 * waiting for the production budget.
 */
const FORWARD_TIMEOUT_MS = (() => {
  const override = Number.parseInt(
    process.env.CTRLYOKE_STATUSLINE_FORWARD_TIMEOUT_MS ?? "",
    10
  );
  return Number.isFinite(override) && override > 0
    ? override
    : DEFAULT_FORWARD_TIMEOUT_MS;
})();
const ANSI_RESET = "\u001b[0m";
const DEFAULT_PERCENT_DIRECTION = "used";

const STATUSLINE_PROVIDERS = Object.freeze({
  CLAUDE: "claude",
  ANTIGRAVITY: "antigravity",
  COPILOT: "copilot",
  QWEN: "qwen",
});

const STATUSLINE_HARNESS_IDS = Object.freeze({
  [STATUSLINE_PROVIDERS.CLAUDE]: "claude-cli",
  [STATUSLINE_PROVIDERS.ANTIGRAVITY]: "antigravity-cli",
  [STATUSLINE_PROVIDERS.COPILOT]: "copilot-cli",
  [STATUSLINE_PROVIDERS.QWEN]: "qwen-cli",
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

function readSettingsFile(settingsPath) {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    let parsed;
    try {
      const migration = migrateToCurrent(PERSISTED_STORES.SETTINGS, raw);
      if (
        migration.fromVersion >
        CURRENT_SCHEMA_VERSIONS[PERSISTED_STORES.SETTINGS]
      ) {
        return { found: true, unsupported: true, settings: {} };
      }
      parsed = migration.doc;
    } catch {
      return { found: true, settings: {} };
    }
    return {
      found: true,
      settings:
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? parsed
          : {},
    };
  } catch {
    return { found: false, settings: {} };
  }
}

function readWorkspaceSettings(workspaceRoot) {
  if (typeof workspaceRoot !== "string" || workspaceRoot.trim().length === 0) {
    return {};
  }

  const settingsPath = path.join(workspaceRoot, ".ctrlyoke", "settings.json");
  return readSettingsFile(settingsPath).settings;
}

/**
 * Find a workspace settings file from a provider payload's cwd. This is only
 * a fallback for statusline invocations outside a ctrlyoke-launched process;
 * launched processes provide the exact effective root through the environment
 * handoff below. Walking ancestors lets a harness payload cwd be a project
 * subdirectory without mistaking it for the configured ctrlyoke root.
 */
function findWorkspaceSettingsFromCwd(cwd) {
  if (typeof cwd !== "string" || cwd.trim().length === 0) {
    return {};
  }

  let current = path.resolve(cwd);
  while (true) {
    const result = readSettingsFile(
      path.join(current, ".ctrlyoke", "settings.json")
    );
    if (result.found) return result.settings;
    const parent = path.dirname(current);
    if (parent === current) return {};
    current = parent;
  }
}

/**
 * Read settings directly for every wrapper invocation. Provider statusline
 * settings remain user/machine scoped. The one normal-scope leaf,
 * usageTracking.percentDirection, is additionally read from the effective
 * workspace file when a launched process hands us its configured root; an
 * external invocation falls back to the payload cwd ancestor search.
 */
function resolveStatusLineSettings(
  provider,
  homeDirectory = os.homedir(),
  context = {}
) {
  const userSettings = readSettingsFile(
    path.join(homeDirectory, ".ctrlyoke", "settings.json")
  );
  if (userSettings.unsupported) {
    return { ...DEFAULT_STATUSLINE_SETTINGS, enabled: false };
  }
  const workspaceSettings =
    typeof context.workspaceRoot === "string"
      ? readWorkspaceSettings(context.workspaceRoot)
      : findWorkspaceSettingsFromCwd(
          getStatusLineWorkspaceDirectory(context.payload)
        );
  const settings = userSettings.settings;
  const statusLine = settings.statusLine;
  const tracking =
    statusLine && typeof statusLine === "object" && !Array.isArray(statusLine)
      ? statusLine
      : undefined;
  const configured =
    tracking && typeof tracking === "object" && !Array.isArray(tracking)
      ? tracking.byHarness?.[STATUSLINE_HARNESS_IDS[provider]]
      : undefined;
  const userUsageTracking = settings.usageTracking;
  const workspaceUsageTracking = workspaceSettings.usageTracking;
  const percentDirection =
    [workspaceUsageTracking, userUsageTracking].find(
      (usageTracking) =>
        usageTracking &&
        typeof usageTracking === "object" &&
        !Array.isArray(usageTracking) &&
        (usageTracking.percentDirection === "used" ||
          usageTracking.percentDirection === "remaining")
    )?.percentDirection ?? DEFAULT_PERCENT_DIRECTION;
  const useDifferentFormatPerHarness =
    typeof tracking?.useDifferentFormatPerHarness === "boolean"
      ? tracking.useDifferentFormatPerHarness
      : false;
  const candidateFormat = useDifferentFormatPerHarness
    ? configured?.format
    : tracking?.sharedFormat;
  const effectiveFormat =
    Array.isArray(candidateFormat) && candidateFormat.length > 0
      ? candidateFormat
      : cloneDefaultStatuslineFormat();

  const defaults = {
    ...DEFAULT_STATUSLINE_SETTINGS,
    format: effectiveFormat,
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
    format: effectiveFormat,
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
      protocolVersion: STATUSLINE_SNAPSHOT_PROTOCOL_VERSION,
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
 * Forwarding is best-effort. The result distinguishes a timeout from a command
 * that completed with empty output, while preserving any stdout received.
 * Wrappers pass FORWARD_TIMEOUT_MS (1500 ms unless overridden) by default.
 */
function forwardToCommand(
  command,
  inputBytes,
  timeoutMs = FORWARD_TIMEOUT_MS,
  options = {}
) {
  if (typeof command !== "string" || command.trim().length === 0) {
    return Promise.resolve({ output: Buffer.alloc(0), timedOut: false });
  }

  return new Promise((resolve) => {
    let child;
    try {
      child = (options.spawnImpl ?? spawn)(command, {
        shell: true,
        windowsHide: true,
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch {
      resolve({ output: Buffer.alloc(0), timedOut: false });
      return;
    }

    const output = [];
    let settled = false;
    let timer;
    const settle = (timedOut = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ output: Buffer.concat(output), timedOut });
    };
    timer = setTimeout(() => {
      try {
        if ((options.platform ?? process.platform) === "win32" && child.pid) {
          const killer = (options.spawnImpl ?? spawn)(
            "taskkill",
            ["/T", "/F", "/PID", String(child.pid)],
            { windowsHide: true, stdio: "ignore" }
          );
          killer.once("error", () => {});
        } else {
          child.kill();
        }
      } catch {
        // The wrapper remains non-fatal if the child cannot be killed.
      }
      settle(true);
    }, timeoutMs);

    child.stdout.on("data", (chunk) => output.push(Buffer.from(chunk)));
    child.once("error", () => settle());
    child.once("close", () => settle());
    child.stdin.on("error", () => settle());
    try {
      child.stdin.end(
        Buffer.isBuffer(inputBytes) ? inputBytes : Buffer.from(inputBytes)
      );
    } catch {
      settle();
    }
  });
}

function getForwardedOutputCachePath(harnessId, homeDirectory = os.homedir()) {
  if (typeof harnessId !== "string" || !/^[a-z0-9-]+$/.test(harnessId)) {
    return undefined;
  }
  return path.join(
    homeDirectory,
    ".ctrlyoke",
    "cache",
    "statusline-forwarded",
    `${harnessId}.txt`
  );
}

function readForwardedOutputCache(harnessId) {
  const cachePath = getForwardedOutputCachePath(harnessId);
  if (!cachePath) return Buffer.alloc(0);
  try {
    return fs.readFileSync(cachePath);
  } catch {
    return Buffer.alloc(0);
  }
}

async function forwardStatuslineCommand(
  command,
  inputBytes,
  harnessId,
  timeoutMs = FORWARD_TIMEOUT_MS,
  options = {}
) {
  const result = await forwardToCommand(
    command,
    inputBytes,
    timeoutMs,
    options
  );
  const cachePath = getForwardedOutputCachePath(harnessId);
  if (result.timedOut) {
    return result.output.length > 0
      ? result.output
      : readForwardedOutputCache(harnessId);
  }
  if (result.output.length > 0 && cachePath) {
    try {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      const tempPath = `${cachePath}.tmp-${process.pid}`;
      fs.writeFileSync(tempPath, result.output);
      fs.renameSync(tempPath, cachePath);
    } catch {
      // Forwarding remains best-effort when the cache cannot be written.
    }
  }
  return result.output;
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

function getGitHeadPath(currentDirectory) {
  if (typeof currentDirectory !== "string" || currentDirectory.length === 0) {
    return undefined;
  }

  let current = path.resolve(currentDirectory);
  while (true) {
    const gitPath = path.join(current, ".git");
    try {
      const gitStats = fs.statSync(gitPath);
      if (gitStats.isDirectory()) {
        return path.join(gitPath, "HEAD");
      }
      if (!gitStats.isFile()) {
        return undefined;
      }

      const gitFile = fs.readFileSync(gitPath, "utf8").trim();
      const gitDirectory = gitFile.match(/^gitdir:\s*(.+)$/i)?.[1]?.trim();
      return gitDirectory
        ? path.resolve(path.dirname(gitPath), gitDirectory, "HEAD")
        : undefined;
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") {
        return undefined;
      }
    }

    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function getBranchName(payload) {
  try {
    const headPath = getGitHeadPath(getStatusLineWorkspaceDirectory(payload));
    if (!headPath) {
      return undefined;
    }
    const head = fs.readFileSync(headPath, "utf8").trim();
    if (head.startsWith("ref: refs/heads/")) {
      const branch = head.slice("ref: refs/heads/".length).trim();
      return branch.length > 0 ? branch : undefined;
    }
    return head.length > 0 ? head.slice(0, 7) : undefined;
  } catch {
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
  return formatSharedBrandedStatusLine(
    provider,
    payload,
    Array.isArray(format) ? format : undefined,
    percentDirection,
    { branch: getBranchName(payload) }
  );
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
  STATUSLINE_HARNESS_IDS,
  DEFAULT_STATUSLINE_SETTINGS,
  asFiniteNumber,
  buildSnapshotPayload,
  calculateContextPercentage,
  formatBrandedStatusLine,
  formatCompactTokenCount,
  formatUsagePercentForDisplay,
  forwardToCommand,
  forwardStatuslineCommand,
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
