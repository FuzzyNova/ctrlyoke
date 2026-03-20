#!/usr/bin/env node

/**
 * FlightPath Gemini Hook Handler
 *
 * This script is executed by Gemini CLI when hook events occur.
 * It receives hook input JSON via stdin and writes a notification file
 * that FlightPath monitors for session discovery and completion detection.
 *
 * Supported hook events:
 * - SessionStart: Called when new session starts (provides session ID immediately)
 * - AfterAgent: Called when execution completes (normalized to "Stop" in notification)
 *
 * Usage (configured by FlightPath via .gemini/settings.json):
 *   { "hooks": { "SessionStart": [...], "AfterAgent": [...] } }
 *
 * Hook input format (from Gemini via stdin):
 * {
 *   "session_id": "abc123",
 *   "transcript_path": "~/.gemini/...",
 *   "cwd": "/workspace",
 *   "hook_event_name": "SessionStart" | "AfterAgent",
 *   "timestamp": "2024-..."
 * }
 *
 * Notification directory is passed as first command-line argument.
 *
 * Debug logging: All hook data logged to <workspace>/.flightpath/logs/flightpath-gemini-hook-debug.log
 */

const fs = require("fs");
const path = require("path");
const { initializeLogger, readStdinJson } = require("./flightpath-hook-utils");

const SCRIPT_NAME = "flightpath-gemini-hook";
const SCRIPT_PREFIX = "FlightPath Gemini Hook";

function main() {
  const notifyDir = process.argv[2];
  const debugLog = initializeLogger(SCRIPT_NAME, notifyDir);

  debugLog("🚀 Gemini hook script invoked", {
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

    if (hookEvent !== "SessionStart" && hookEvent !== "AfterAgent") {
      debugLog("⏭️ Ignoring non-SessionStart/AfterAgent hook event", { hookEvent });
      process.exit(0);
    }

    const sessionId = hookInput.session_id;
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

    // Normalize AfterAgent → "Stop" so NotificationMonitorBase works unchanged
    const isCompletion = hookEvent === "AfterAgent";
    const safeSessionId = path.basename(sessionId);
    const notifyFile = path.join(
      notifyDir,
      isCompletion
        ? `${safeSessionId}-stop.json`
        : `${safeSessionId}-start.json`
    );

    const notifyData = {
      timestamp: Date.now(),
      sessionId,
      status: isCompletion ? "completed" : "started",
      hookEvent: isCompletion ? "Stop" : "SessionStart",
      transcriptPath: hookInput.transcript_path,
      cwd: hookInput.cwd,
    };

    fs.writeFileSync(notifyFile, JSON.stringify(notifyData, null, 2));
    debugLog("✅ Notification file written", { notifyFile, notifyData });
    debugLog(`✅ Hook ${hookEvent} completed successfully`);
    process.exit(0);
  });
}

main();
