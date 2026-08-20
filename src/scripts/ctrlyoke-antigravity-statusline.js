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
  writeSnapshotAtomic(
    env.CTRLYOKE_AGY_STATUSLINE_DIR,
    "agy-statusline",
    env.CTRLYOKE_AGY_STATUSLINE_TOKEN,
    payload,
    Date.now()
  );

  const forwardedOutput = await forwardToCommand(
    env.CTRLYOKE_AGY_STATUSLINE_FORWARD,
    input,
    FORWARD_TIMEOUT_MS
  );
  if (env.CTRLYOKE_AGY_STATUSLINE_USE_CTRLYOKE_STYLE === "true") {
    writeStdoutSafely(
      formatBrandedStatusLine(STATUSLINE_PROVIDERS.ANTIGRAVITY, payload)
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
