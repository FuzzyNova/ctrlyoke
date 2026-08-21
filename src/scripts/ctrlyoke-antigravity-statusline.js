#!/usr/bin/env node

/** ctrlyoke Antigravity statusline wrapper. */

const {
  FORWARD_TIMEOUT_MS,
  STATUSLINE_PROVIDERS,
  formatBrandedStatusLine,
  formatCompactTokenCount,
  forwardToCommand,
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
  const settings = resolveStatusLineSettings(STATUSLINE_PROVIDERS.ANTIGRAVITY);
  if (settings.enabled) {
    writeSnapshotAtomic(
      env.CTRLYOKE_AGY_STATUSLINE_DIR,
      "agy-statusline",
      env.CTRLYOKE_AGY_STATUSLINE_TOKEN,
      payload,
      Date.now()
    );
  }

  const forwardedOutput = await forwardToCommand(
    settings.customCommand,
    input,
    FORWARD_TIMEOUT_MS
  );
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
