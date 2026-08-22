#!/usr/bin/env node

/** ctrlyoke Copilot statusline wrapper. */

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
  const settings = resolveStatusLineSettings(
    STATUSLINE_PROVIDERS.COPILOT,
    undefined,
    {
      payload,
      workspaceRoot: env.CTRLYOKE_STATUSLINE_WORKSPACE_ROOT,
    }
  );
  if (settings.enabled) {
    writeSnapshotAtomic(
      env.CTRLYOKE_COPILOT_STATUSLINE_DIR,
      "copilot-statusline",
      env.CTRLYOKE_COPILOT_STATUSLINE_TOKEN,
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
        STATUSLINE_PROVIDERS.COPILOT,
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
  runStatusline,
};
