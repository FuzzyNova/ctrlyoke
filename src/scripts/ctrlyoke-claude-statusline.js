#!/usr/bin/env node

/** ctrlyoke Claude statusline wrapper. */

const {
  FORWARD_TIMEOUT_MS,
  STATUSLINE_PROVIDERS,
  formatBrandedStatusLine,
  forwardToCommand,
  parsePayload,
  readStdinBytes,
  writeSnapshotAtomic,
  writeStdoutSafely,
} = require("./ctrlyoke-statusline-wrapper.js");

async function runStatusline(input, env = process.env) {
  const payload = parsePayload(input);
  writeSnapshotAtomic(
    env.CTRLYOKE_CLAUDE_STATUSLINE_DIR,
    "claude-statusline",
    env.CTRLYOKE_CLAUDE_STATUSLINE_TOKEN,
    payload,
    Date.now()
  );

  const forwardedOutput = await forwardToCommand(
    env.CTRLYOKE_CLAUDE_STATUSLINE_FORWARD,
    input,
    FORWARD_TIMEOUT_MS
  );
  if (env.CTRLYOKE_CLAUDE_STATUSLINE_USE_CTRLYOKE_STYLE === "true") {
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
