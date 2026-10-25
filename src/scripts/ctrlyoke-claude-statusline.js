#!/usr/bin/env node

/** ctrlyoke Claude statusline wrapper. */

const {
  FORWARD_TIMEOUT_MS,
  STATUSLINE_HARNESS_IDS,
  STATUSLINE_PROVIDERS,
  formatBrandedStatusLine,
  forwardStatuslineCommand,
  parsePayload,
  readStdinBytes,
  resolveStatusLineSettings,
  writeSnapshotAtomic,
  writeStdoutSafely,
} = require("./ctrlyoke-statusline-wrapper.js");

async function runStatusline(input, env = process.env) {
  const payload = parsePayload(input);
  const settings = resolveStatusLineSettings(
    STATUSLINE_PROVIDERS.CLAUDE,
    undefined,
    {
      payload,
      workspaceRoot: env.CTRLYOKE_STATUSLINE_WORKSPACE_ROOT,
    }
  );
  if (settings.enabled) {
    writeSnapshotAtomic(
      env.CTRLYOKE_CLAUDE_STATUSLINE_DIR,
      "claude-statusline",
      env.CTRLYOKE_CLAUDE_STATUSLINE_TOKEN,
      payload,
      Date.now()
    );
  }

  if (settings.enabled && settings.useCtrlyokeStyle) {
    writeStdoutSafely(
      formatBrandedStatusLine(
        STATUSLINE_PROVIDERS.CLAUDE,
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
    STATUSLINE_HARNESS_IDS[STATUSLINE_PROVIDERS.CLAUDE],
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
  runStatusline,
};
