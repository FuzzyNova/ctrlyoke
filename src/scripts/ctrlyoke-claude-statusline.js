#!/usr/bin/env node

/** ctrlyoke Claude statusline wrapper. */

const {
  FORWARD_TIMEOUT_MS,
  STATUSLINE_PROVIDERS,
  formatBrandedStatusLine,
  forwardToCommand,
  parsePayload,
  readStdinBytes,
  resolveStatusLineSettings,
  writeSnapshotAtomic,
  writeStdoutSafely,
} = require("./ctrlyoke-statusline-wrapper.js");

async function runStatusline(input, env = process.env) {
  const payload = parsePayload(input);
  const settings = resolveStatusLineSettings(STATUSLINE_PROVIDERS.CLAUDE);
  if (settings.enabled) {
    writeSnapshotAtomic(
      env.CTRLYOKE_CLAUDE_STATUSLINE_DIR,
      "claude-statusline",
      env.CTRLYOKE_CLAUDE_STATUSLINE_TOKEN,
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
      formatBrandedStatusLine(STATUSLINE_PROVIDERS.CLAUDE, payload)
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
  runStatusline,
};
