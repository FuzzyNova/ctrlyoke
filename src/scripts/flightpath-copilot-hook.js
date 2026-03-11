#!/usr/bin/env node

/**
 * FlightPath Copilot CLI Hook Handler
 *
 * This script is executed by Copilot CLI when hook events occur.
 * It receives hook input JSON via stdin and writes a notification file
 * that FlightPath monitors for session discovery and completion detection.
 *
 * Notification file format mirrors flightpath-claude-hook.js for consistency:
 * - SessionStart: {sessionId}-start.json  → { hookEvent: "SessionStart", sessionId, status: "started" }
 * - SessionEnd:   {sessionId}-stop.json   → { hookEvent: "Stop", sessionId, status: "completed" }
 *
 * Using the same format as Claude's hook allows NotificationMonitorBase to share
 * all monitoring logic (waitForSessionStart, monitorForCompletion, cleanupNotificationFiles).
 *
 * Usage (configured by FlightPath via .github/hooks/*.json):
 * {
 *   "version": 1,
 *   "hooks": {
 *     "sessionStart": [{"type": "command", "bash": "node <script> <dir> sessionStart"}],
 *     "sessionEnd": [{"type": "command", "bash": "node <script> <dir> sessionEnd"}]
 *   }
 * }
 *
 * Copilot hook input format (via stdin):
 * {
 *   "sessionId": "970deee9-5760-4843-a2a3-8067d1dc79ea",
 *   "timestamp": 1772552070055,
 *   "cwd": "C:\\dev\\FlightPath",
 *   "source": "new",          // sessionStart only
 *   "initialPrompt": "...",   // sessionStart only
 *   "reason": "complete"      // sessionEnd only
 * }
 *
 * Arguments:
 * - argv[2]: Notification directory
 * - argv[3]: Hook type (sessionStart | sessionEnd)
 *
 * Debug logging: All hook data logged to <workspace>/.flightpath/logs/flightpath-copilot-hook-debug.log
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const {
  isDiagnosticLogsEnabled,
  getDebugLogPath,
  createLogger,
  getLogsDirFromNotifyDir,
  getWorkspaceRootFromNotifyDir,
} = require("./flightpath-hook-utils");

const SCRIPT_NAME = "flightpath-copilot-hook";
let debugLog = createLogger(null); // Will be re-initialized after parsing arguments

/**
 * Main handler function
 */
function main() {
  // Initialize debug logging only when diagnostic logs are enabled.
  // Check the workspace flag file (.flightpath/.diagnostic-logs) to decide.
  const notifyDir = process.argv[2];
  try {
    if (notifyDir) {
      const workspaceRoot = getWorkspaceRootFromNotifyDir(notifyDir);
      if (isDiagnosticLogsEnabled(workspaceRoot)) {
        const logsDir = getLogsDirFromNotifyDir(notifyDir);
        debugLog = createLogger(getDebugLogPath(logsDir, SCRIPT_NAME));
      }
    }
    debugLog("🚀 Hook script invoked", {
      argv: process.argv,
      argvLength: process.argv.length,
      cwd: process.cwd(),
      env_keys: Object.keys(process.env),
    });
  } catch (err) {
    // Ignore errors — logger stays as no-op
  }

  // Arguments: node <script> <notifyDir> <hookType>
  if (process.argv.length < 4) {
    const errorMsg = `Missing required arguments (notifyDir and hookType). Received ${process.argv.length - 1} argument(s): ${process.argv.slice(2).join(", ")}`;
    debugLog("❌ FATAL ERROR: " + errorMsg, {
      argv: process.argv,
      expected: "node <script> <notifyDir> <hookType>",
    });
    console.error("FlightPath Copilot Hook: " + errorMsg);
    process.exit(1);
  }

  const hookType = process.argv[3];

  debugLog("📁 Hook configuration", { notifyDir, hookType });

  // Read hook input JSON from stdin (Copilot hook format)
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
    debugLog(`🔚 Stdin closed for ${hookType}`, {
      hookType,
      totalLines: lineCount,
      totalLength: inputData.length,
      rawInput: inputData,
    });

    try {
      // Parse hook input
      debugLog("🔍 Attempting to parse JSON...");
      const hookInput = JSON.parse(inputData);
      debugLog(`✅ JSON parsed successfully for ${hookType}`, {
        hookType,
        parsedData: hookInput,
      });

      // Extract session ID from Copilot's hook data
      const sessionId = hookInput.sessionId || hookInput.session_id;

      if (sessionId) {
        debugLog("🔑 Session ID found!", { hookType, sessionId });
      } else {
        debugLog("⚠️ No session ID found in hook data", {
          hookType,
          availableFields: Object.keys(hookInput),
        });
      }

      // Write notification files for sessionStart and sessionEnd
      if (hookType === "sessionStart" || hookType === "sessionEnd") {
        // Ensure notification directory exists
        if (!fs.existsSync(notifyDir)) {
          fs.mkdirSync(notifyDir, { recursive: true });
          debugLog("📁 Created notification directory", { notifyDir });
        }

        // Use same file naming convention as flightpath-claude-hook.js:
        //   sessionStart → {sessionId}-start.json
        //   sessionEnd   → {sessionId}-stop.json
        // Separate files prevent any overwrite race conditions and allow
        // NotificationMonitorBase to share all monitoring logic between providers.
        const safeSessionId = sessionId ? path.basename(sessionId) : null;
        const filename = safeSessionId
          ? hookType === "sessionStart"
            ? `${safeSessionId}-start.json`
            : `${safeSessionId}-stop.json`
          : `${hookType}-${Date.now()}.json`;
        const notifyFile = path.join(notifyDir, filename);

        // Create notification data using the same schema as flightpath-claude-hook.js
        const notifyData = {
          timestamp: Date.now(),
          sessionId: sessionId || null,
          status: hookType === "sessionStart" ? "started" : "completed",
          // hookEvent matches Claude's format: "SessionStart" | "Stop"
          hookEvent: hookType === "sessionStart" ? "SessionStart" : "Stop",
          cwd: hookInput.cwd,
          rawHookData: hookInput,
        };

        // Write to file (FlightPath will read and delete)
        fs.writeFileSync(notifyFile, JSON.stringify(notifyData, null, 2));
        debugLog("✅ Notification file written", { notifyFile, notifyData });
      } else {
        debugLog(`⏭️ Hook ${hookType} processed (not writing notification)`, {
          hookType,
          sessionId: sessionId || "none",
        });
      }

      // Exit 0 to signal success
      debugLog(`✅ Hook ${hookType} completed successfully`);
      process.exit(0);
    } catch (error) {
      debugLog("❌ ERROR: Exception during processing", {
        hookType,
        message: error.message,
        stack: error.stack,
        inputData: inputData,
      });
      console.error(
        `FlightPath Copilot Hook (${hookType}): Error processing hook input:`,
        error.message
      );
      // Exit 1 to signal error
      process.exit(1);
    }
  });
}

main();
