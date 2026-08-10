#!/usr/bin/env node

/**
 * ctrlyoke Claude statusline wrapper.
 *
 * Claude supplies the JSON statusline payload on stdin. The payload is written
 * only to the workspace temp transport selected by the provider, then the
 * user's previous statusline command is forwarded unchanged when present.
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

let snapshotSequence = 0;

function safeToken(token) {
  return typeof token === "string" && token.length > 0
    ? token.replace(/[^a-zA-Z0-9._-]/g, "_")
    : undefined;
}

function writeSnapshot(directory, token, input) {
  const safe = safeToken(token);
  if (typeof directory !== "string" || directory.length === 0 || !safe) {
    return;
  }

  const target = path.join(directory, `claude-statusline-${safe}.json`);
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    const payload = JSON.parse(input);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return;
    }
    snapshotSequence += 1;
    const snapshot = JSON.stringify({
      ...payload,
      _ctrlyoke: {
        sequence: snapshotSequence,
        writtenAt: Date.now(),
      },
    });
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(temp, snapshot);
    fs.renameSync(temp, target);
  } catch {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // Best-effort cleanup only.
    }
  }
}

function forwardStatusline(input, command) {
  if (typeof command !== "string" || command.length === 0) {
    return "";
  }
  try {
    const result = spawnSync(command, {
      input,
      encoding: "utf8",
      shell: true,
      timeout: 500,
      windowsHide: true,
    });
    return typeof result.stdout === "string" ? result.stdout : "";
  } catch {
    return "";
  }
}

function run(input, env = process.env) {
  writeSnapshot(
    env.CTRLYOKE_CLAUDE_STATUSLINE_DIR,
    env.CTRLYOKE_CLAUDE_STATUSLINE_TOKEN,
    input
  );
  process.stdout.write(
    forwardStatusline(input, env.CTRLYOKE_CLAUDE_STATUSLINE_FORWARD)
  );
}

let input = "";
try {
  input = fs.readFileSync(0, "utf8");
} catch {
  input = "";
}
run(input);
