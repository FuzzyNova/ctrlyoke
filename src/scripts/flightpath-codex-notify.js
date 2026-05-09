#!/usr/bin/env node

/**
 * FlightPath Codex Hook Handler
 *
 * This script is executed by Codex CLI when hook events occur.
 * It receives hook input JSON via stdin and writes a notification file
 * that FlightPath monitors for session discovery and completion detection.
 *
 * Supported hook events:
 * - SessionStart: Called when a new session starts (provides session ID immediately)
 * - Stop: Called when execution completes
 *
 * Usage (configured by FlightPath via .codex/hooks.json, requires --enable codex_hooks):
 *   { "hooks": { "SessionStart": [{ "matcher": "", "hooks": [{ "type": "command", "command": "node <script> <notifyDir>" }] }], "Stop": [...] } }
 *
 * Hook input format (from Codex via stdin):
 * {
 *   "session_id": "abc123",
 *   "transcript_path": "~/.codex/.../session.jsonl",
 *   "cwd": "/workspace",
 *   "permission_mode": "default",
 *   "hook_event_name": "SessionStart" | "Stop",
 *   "stop_hook_active": true,
 *   "last_assistant_message": "...",
 *   "source": "startup" | "resume" | "clear"
 * }
 *
 * Notification directory is passed as first command-line argument.
 *
 * Debug logging: All hook data logged to <workspace>/.flightpath/logs/flightpath-codex-notify-debug.log
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  initializeLogger,
  readStdinJson,
  maybeWriteHookArtifact,
  runDecisionHook,
} = require("./flightpath-hook-utils");

const SCRIPT_NAME = "flightpath-codex-notify";
const SCRIPT_PREFIX = "FlightPath Codex Hook";

function main() {
  const notifyDir = process.argv[2];
  const encodedDecisionHook = process.argv[3];

  // Unconditional invocation log — written before any flag checks so we can confirm
  // the hook script is being called at all, regardless of diagnostic settings.
  try {
    const logsDir = notifyDir ? path.join(notifyDir, "..", "..", "logs") : null;
    const logFile = logsDir
      ? path.join(logsDir, `${SCRIPT_NAME}-debug.log`)
      : path.join(os.tmpdir(), `${SCRIPT_NAME}-invocations.log`);
    if (logsDir) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    fs.appendFileSync(
      logFile,
      `[${new Date().toISOString()}] invoked argv=${JSON.stringify(process.argv)}\n`
    );
  } catch {
    // Never block hook execution on logging
  }

  const debugLog = initializeLogger(SCRIPT_NAME, notifyDir);

  debugLog("🚀 Codex hook script invoked", {
    argv: process.argv,
    argvLength: process.argv.length,
    cwd: process.cwd(),
    env_keys: Object.keys(process.env),
  });

  if (process.argv.length < 3) {
    const errorMsg = `No notification directory provided. Received ${process.argv.length - 1} argument(s): ${process.argv.slice(2).join(", ")}`;
    debugLog("❌ FATAL ERROR: " + errorMsg, {
      argv: process.argv,
      expected: "node <script> <notifyDir>",
    });
    console.error(`${SCRIPT_PREFIX}: ${errorMsg}`);
    process.exit(1);
  }

  debugLog("📁 Hook configuration", { notifyDir });

  readStdinJson(SCRIPT_PREFIX, debugLog, (hookInput) => {
    const hookEvent = hookInput.hook_event_name;
    debugLog("🎯 Hook event identified", {
      hookEvent,
      allFields: Object.keys(hookInput),
    });

    const HANDLED_EVENTS = new Set([
      "SessionStart",
      "Stop",
      "PreToolUse",
      "PostToolUse",
      "UserPromptSubmit",
      "PermissionRequest",
    ]);

    if (!HANDLED_EVENTS.has(hookEvent)) {
      debugLog("⏭️ Ignoring unhandled hook event", { hookEvent });
      process.exit(0);
    }

    const sessionId = hookInput.session_id;
    const toolName = hookInput.tool_name || hookInput.tool?.name;

    // Map native event to logical name
    const LOGICAL_EVENT_MAP = {
      PreToolUse: "preToolUse",
      PostToolUse: "postToolUse",
      UserPromptSubmit: "userPromptSubmit",
      PermissionRequest: "permissionRequest",
      Stop: "stop",
      SessionStart: "sessionStart",
    };
    const logicalEvent = LOGICAL_EVENT_MAP[hookEvent];
    if (logicalEvent && notifyDir) {
      maybeWriteHookArtifact(
        logicalEvent,
        hookEvent,
        hookInput,
        notifyDir,
        sessionId,
        toolName,
        debugLog
      );
    }

    if (hookEvent === "PermissionRequest") {
      if (encodedDecisionHook) {
        const decisionHookCommand = Buffer.from(
          encodedDecisionHook,
          "base64"
        ).toString("utf8");
        process.exit(
          runDecisionHook(
            decisionHookCommand,
            JSON.stringify(hookInput),
            debugLog
          )
        );
      }
      debugLog(`✅ Hook ${hookEvent} completed`);
      process.exit(0);
    }

    // Events that don't need notification file I/O
    if (
      hookEvent === "PreToolUse" ||
      hookEvent === "PostToolUse" ||
      hookEvent === "UserPromptSubmit"
    ) {
      debugLog(`✅ Hook ${hookEvent} completed`);
      process.exit(0);
    }

    if (!sessionId) {
      const errorMsg = `Missing session_id in ${hookEvent} hook input`;
      debugLog("❌ ERROR: " + errorMsg, { hookInput });
      console.error(`${SCRIPT_PREFIX}: ${errorMsg}`);
      process.exit(1);
    }

    debugLog("🔑 Session ID extracted", { hookEvent, sessionId });

    if (!fs.existsSync(notifyDir)) {
      fs.mkdirSync(notifyDir, { recursive: true });
      debugLog("📁 Created notification directory", { notifyDir });
    }

    const safeSessionId = path.basename(sessionId);
    const isStartEvent = hookEvent === "SessionStart";
    // For start events, use FLIGHTPATH_RUN_ID as the file prefix when set.
    // This gives each parallel workflow its own uniquely-named start file so
    // waitForSessionStart can do a direct lookup instead of a wildcard scan.
    const runId = process.env.FLIGHTPATH_RUN_ID
      ? path.basename(process.env.FLIGHTPATH_RUN_ID)
      : null;
    const startPrefix = runId || safeSessionId;
    const notifyFile = path.join(
      notifyDir,
      isStartEvent ? `${startPrefix}-start.json` : `${safeSessionId}-stop.json`
    );

    const notifyData = {
      timestamp: Date.now(),
      sessionId,
      status: isStartEvent ? "started" : "completed",
      hookEvent,
      transcriptPath: hookInput.transcript_path,
      permissionMode: hookInput.permission_mode,
      stopHookActive: hookInput.stop_hook_active,
    };

    fs.writeFileSync(notifyFile, JSON.stringify(notifyData, null, 2));
    debugLog("✅ Notification file written", { notifyFile, notifyData });
    debugLog(`✅ Hook ${hookEvent} completed successfully`);
    process.exit(0);
  });
}

main();
