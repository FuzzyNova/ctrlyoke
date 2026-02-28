#!/usr/bin/env node

/**
 * FlightPath Claude Hook Handler
 *
 * This script is executed by Claude CLI when hook events occur.
 * It receives hook input JSON via stdin and writes a notification file
 * that FlightPath monitors for session discovery and completion detection.
 *
 * Supported hook events:
 * - SessionStart: Called when new session starts (provides session ID immediately)
 * - Stop: Called when execution completes (for completion detection)
 *
 * Usage (configured by FlightPath via --settings):
 *   claude --settings '{"hooks":{"SessionStart":[...], "Stop":[...]}}' ...
 *
 * Hook input format (from Claude via stdin):
 * {
 *   "session_id": "abc123",
 *   "transcript_path": "~/.claude/projects/.../session.jsonl",
 *   "permission_mode": "default",
 *   "hook_event_name": "SessionStart" | "Stop",
 *   "session_start_hook_active": true,
 *   "stop_hook_active": true
 * }
 *
 * Notification directory is passed as first command-line argument.
 *
 * Debug logging: All hook data logged to <workspace>/.flightpath/logs/flightpath-claude-hook-debug.log
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const {
  getDebugLogPath,
  getTempLogPath,
  createLogger,
  getLogsDirFromNotifyDir,
} = require("./flightpath-hook-utils");

const SCRIPT_NAME = "flightpath-claude-hook";
let debugLog = createLogger(null); // Will be re-initialized after parsing arguments

/**
 * Main handler function
 */
function main() {
  // Try to initialize debug logging as early as possible
  // ALWAYS get a log file somewhere (fallback to temp if notifyDir is missing)
  const notifyDir = process.argv[2];
  try {
    if (notifyDir) {
      const logsDir = getLogsDirFromNotifyDir(notifyDir);
      debugLog = createLogger(getDebugLogPath(logsDir, SCRIPT_NAME));
    } else {
      debugLog = createLogger(getTempLogPath(SCRIPT_NAME));
    }
    debugLog("🚀 Claude hook script invoked", {
      argv: process.argv,
      argvLength: process.argv.length,
      cwd: process.cwd(),
      env_keys: Object.keys(process.env),
    });
  } catch (err) {
    // Last resort fallback
    debugLog = createLogger(getTempLogPath(SCRIPT_NAME));
  }

  // Notification directory passed as first argument
  if (process.argv.length < 3) {
    const errorMsg = `No notification directory provided. Received ${process.argv.length - 1} argument(s): ${process.argv.slice(2).join(", ")}`;
    debugLog("❌ FATAL ERROR: " + errorMsg, {
      argv: process.argv,
      expected: "node <script> <notifyDir>",
    });
    console.error("FlightPath Claude Hook: " + errorMsg);
    process.exit(1);
  }

  debugLog("📁 Hook configuration", { notifyDir });

  // Read hook input JSON from stdin (Claude hook format)
  debugLog("📥 Starting stdin read...");
  let inputData = "";
  let lineCount = 0;
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  rl.on("line", (line) => {
    lineCount++;
    inputData += line;
    debugLog(`📝 Line ${lineCount} received`, { line, length: line.length });
  });

  rl.on("close", () => {
    debugLog("🔚 Stdin closed", {
      totalLines: lineCount,
      totalLength: inputData.length,
      rawInput: inputData,
    });

    try {
      // Parse hook input
      debugLog("🔍 Attempting to parse JSON...");
      const hookInput = JSON.parse(inputData);
      debugLog("✅ JSON parsed successfully", {
        parsedData: hookInput,
      });

      // Validate hook event name
      const hookEvent = hookInput.hook_event_name;
      debugLog("🎯 Hook event identified", {
        hookEvent,
        allFields: Object.keys(hookInput),
      });

      if (hookEvent !== "SessionStart" && hookEvent !== "Stop") {
        debugLog("⏭️ Ignoring non-SessionStart/Stop hook event", {
          hookEvent,
        });
        process.exit(0);
      }

      // Extract session ID
      const sessionId = hookInput.session_id;
      if (!sessionId) {
        const errorMsg = `Missing session_id in ${hookEvent} hook input`;
        debugLog("❌ ERROR: " + errorMsg, { hookInput });
        console.error(`FlightPath Claude Hook: ${errorMsg}`);
        process.exit(1);
      }

      debugLog("🔑 Session ID extracted", { hookEvent, sessionId });

      // Ensure notification directory exists
      if (!fs.existsSync(notifyDir)) {
        fs.mkdirSync(notifyDir, { recursive: true });
        debugLog("📁 Created notification directory", { notifyDir });
      }

      // Write notification file (named by session_id for easy lookup)
      // SessionStart and Stop hooks write to SEPARATE files to avoid race conditions
      const safeSessionId = path.basename(sessionId); // strip any directory components
      const notifyFile = path.join(
        notifyDir,
        hookEvent === "SessionStart"
          ? `${safeSessionId}-start.json`
          : `${safeSessionId}-stop.json`
      );

      // Create notification data
      const notifyData = {
        timestamp: Date.now(),
        sessionId: sessionId,
        status: hookEvent === "SessionStart" ? "started" : "completed",
        hookEvent: hookEvent,
        transcriptPath: hookInput.transcript_path,
        permissionMode: hookInput.permission_mode,
        sessionStartHookActive: hookInput.session_start_hook_active,
        stopHookActive: hookInput.stop_hook_active,
      };

      // Write to file (FlightPath will read and delete)
      fs.writeFileSync(notifyFile, JSON.stringify(notifyData, null, 2));
      debugLog("✅ Notification file written", { notifyFile, notifyData });

      // Exit 0 to allow Claude to continue
      debugLog(`✅ Hook ${hookEvent} completed successfully`);
      process.exit(0);
    } catch (error) {
      debugLog("❌ ERROR: Exception during processing", {
        message: error.message,
        stack: error.stack,
        inputData: inputData,
      });
      console.error(
        "FlightPath Claude Hook: Error processing hook input:",
        error.message
      );
      // Exit 1 to signal error (Claude will show this in debug mode)
      process.exit(1);
    }
  });
}

main();
