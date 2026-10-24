#!/usr/bin/env node

/** ctrlyoke Antigravity statusline wrapper. */

const {
  FORWARD_TIMEOUT_MS,
  STATUSLINE_HARNESS_IDS,
  STATUSLINE_PROVIDERS,
  formatBrandedStatusLine,
  formatCompactTokenCount,
  forwardStatuslineCommand,
  buildSnapshotPayload,
  calculateContextPercentage,
  getContextBand,
  parsePayload,
  readStdinBytes,
  resolveStatusLineSettings,
  writeSnapshotAtomic,
  writeStdoutSafely,
} = require("./ctrlyoke-statusline-wrapper.js");

function writeSnapshot(directory, token, payload, writtenAt) {
  return writeSnapshotAtomic(
    directory,
    "agy-statusline",
    token,
    payload,
    writtenAt
  );
}

async function runStatusline(input, env = process.env) {
  const payload = parsePayload(input);
  const settings = resolveStatusLineSettings(
    STATUSLINE_PROVIDERS.ANTIGRAVITY,
    undefined,
    {
      payload,
      workspaceRoot: env.CTRLYOKE_STATUSLINE_WORKSPACE_ROOT,
    }
  );
  if (settings.enabled) {
    writeSnapshotAtomic(
      env.CTRLYOKE_AGY_STATUSLINE_DIR,
      "agy-statusline",
      env.CTRLYOKE_AGY_STATUSLINE_TOKEN,
      payload,
      Date.now()
    );
  }

  if (settings.enabled && settings.useCtrlyokeStyle) {
    writeStdoutSafely(
      formatBrandedStatusLine(
        STATUSLINE_PROVIDERS.ANTIGRAVITY,
        payload,
        settings.format,
        settings.percentDirection
      )
    );
    return;
  }
  const forwardedOutput = await forwardStatuslineCommand(
    settings.customCommand,
    input,
    STATUSLINE_HARNESS_IDS[STATUSLINE_PROVIDERS.ANTIGRAVITY],
    FORWARD_TIMEOUT_MS
  );
  writeStdoutSafely(forwardedOutput);
}

if (require.main === module) {
  readStdinBytes()
    .then((input) => runStatusline(input))
    .catch(() => {
      // Malformed input, forward failures, and stdin failures are non-fatal.
      process.exitCode = 0;
    });
}

module.exports = {
  buildSnapshotPayload,
  calculateContextPercentage,
  formatBrandedStatusLine: (payload) =>
    formatBrandedStatusLine(STATUSLINE_PROVIDERS.ANTIGRAVITY, payload),
  formatCompactTokenCount,
  getContextBand,
  parsePayload,
  runStatusline,
  writeSnapshot,
};
