#!/usr/bin/env node

/**
 * FlightPath Copilot CLI Hook Handler
 *
 * This script is executed by Copilot CLI when hook events occur.
 * It receives hook input JSON via stdin and writes a notification file
 * that FlightPath monitors for completion detection.
 *
 * Registered hooks:
 * - sessionStart: Log session start data (may contain session ID)
 * - userPromptSubmitted: Log prompt submission data (may contain session ID)
 * - sessionEnd: Write completion notification for FlightPath monitoring
 *
 * Usage (configured by FlightPath via .github/hooks/*.json):
 * {
 *   "version": 1,
 *   "hooks": {
 *     "sessionStart": [{"type": "command", "bash": "node <script> <dir> sessionStart"}],
 *     "userPromptSubmitted": [{"type": "command", "bash": "node <script> <dir> userPromptSubmitted"}],
 *     "sessionEnd": [{"type": "command", "bash": "node <script> <dir> sessionEnd"}]
 *   }
 * }
 *
 * Actual hook input format (discovered via debugging):
 * {
 *   "timestamp": 1768451996969,
 *   "cwd": "C:\\dev\\FlightPath",
 *   "reason": "complete"
 * }
 *
 * Arguments:
 * - argv[2]: Notification directory
 * - argv[3]: Hook type (sessionStart | userPromptSubmitted | sessionEnd)
 *
 * Debug logging: All hook data logged to <workspace>/.flightpath/logs/flightpath-copilot-hook-debug.log
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

const SCRIPT_NAME = "flightpath-copilot-hook";
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
    debugLog("🚀 Hook script invoked", {
      argv: process.argv,
      argvLength: process.argv.length,
      cwd: process.cwd(),
      env_keys: Object.keys(process.env),
    });
  } catch (err) {
    // Last resort fallback
    debugLog = createLogger(getTempLogPath(SCRIPT_NAME));
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

      // Try to extract session ID from various possible fields
      const sessionId =
        hookInput.sessionId ||
        hookInput.session_id ||
        hookInput.id ||
        hookInput.requestId ||
        hookInput.request_id;

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

        // Write notification file
        // Use session ID if available, otherwise use timestamp for wildcard monitoring
        const safeSessionId = sessionId ? path.basename(sessionId) : null;
        const filename = safeSessionId
          ? `${safeSessionId}.json`
          : `${hookType}-${Date.now()}.json`;
        const notifyFile = path.join(notifyDir, filename);

        // Create notification data
        const notifyData = {
          timestamp: Date.now(),
          sessionId: sessionId || null,
          status: hookType === "sessionStart" ? "started" : "completed",
          hookType: hookType,
          reason: hookInput.reason,
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
