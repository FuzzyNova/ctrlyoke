#!/usr/bin/env node

/**
 * FlightPath Codex Notification Handler
 *
 * This script is executed by Codex CLI when agent-turn-complete events occur.
 * It receives a JSON notification as a command-line argument and writes it to
 * a file that FlightPath monitors for completion detection.
 *
 * Usage (configured by FlightPath):
 *   codex --config notify='["node","<path-to-this-script>"]' ...
 *
 * Notification format (from Codex):
 * {
 *   "type": "agent-turn-complete",
 *   "thread-id": "b5f6c1c2-1111-2222-3333-444455556666",
 *   "turn-id": "12345",
 *   "cwd": "/path/to/project",
 *   "input-messages": ["User prompt text"],
 *   "last-assistant-message": "Assistant's final response"
 * }
 *
 * Debug logging: All notification data logged to <workspace>/.flightpath/logs/flightpath-codex-notify-debug.log
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

/**
 * Get debug log file path in .flightpath/logs/
 */
function getDebugLogPath(workspaceDir) {
  try {
    const logsDir = path.join(workspaceDir, ".flightpath", "logs");

    // Ensure logs directory exists
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }

    return path.join(logsDir, "flightpath-codex-notify-debug.log");
  } catch (err) {
    // If anything fails, use temp directory fallback
    return getTempLogPath();
  }
}

/**
 * Fallback: Get debug log file path in system temp directory
 */
function getTempLogPath() {
  return path.join(os.tmpdir(), "flightpath-codex-notify-debug.log");
}

let DEBUG_LOG_FILE = null; // Will be set after parsing notification

/**
 * Debug logging helper
 */
function debugLog(message, data = null) {
  if (!DEBUG_LOG_FILE) {
    return; // Skip logging if path not initialized yet
  }
  try {
    const timestamp = new Date().toISOString();
    let logEntry = `[${timestamp}] ${message}`;
    if (data !== null) {
      logEntry += "\n" + JSON.stringify(data, null, 2);
    }
    logEntry += "\n---\n";
    fs.appendFileSync(DEBUG_LOG_FILE, logEntry);
  } catch (err) {
    // Silently ignore debug logging errors
  }
}

/**
 * Main handler function
 */
function main() {
  // Try to initialize debug logging as early as possible
  // ALWAYS get a log file somewhere (fallback to temp if JSON parse fails or cwd is missing)
  let notificationJson = process.argv[2];
  try {
    if (notificationJson) {
      const notification = JSON.parse(notificationJson);
      if (notification.cwd) {
        DEBUG_LOG_FILE = getDebugLogPath(notification.cwd);
      } else {
        DEBUG_LOG_FILE = getTempLogPath();
      }
    } else {
      DEBUG_LOG_FILE = getTempLogPath();
    }
    debugLog("🚀 Codex notify script invoked", {
      argv: process.argv,
      argvLength: process.argv.length,
      cwd: process.cwd(),
      logLocation: DEBUG_LOG_FILE,
    });
  } catch (err) {
    // Last resort fallback (JSON parse failed)
    DEBUG_LOG_FILE = getTempLogPath();
  }

  // Codex passes notification as first argument (JSON string)
  if (process.argv.length < 3) {
    const errorMsg = `No notification argument provided. Received ${process.argv.length - 1} argument(s): ${process.argv.slice(2).join(", ")}`;
    debugLog("❌ FATAL ERROR: " + errorMsg, {
      argv: process.argv,
      expected: "node <script> <notificationJson>",
    });
    console.error("FlightPath Codex Notify: " + errorMsg);
    process.exit(1);
  }

  try {
    // Parse notification
    const notification = JSON.parse(notificationJson);

    // Initialize debug logging if not already done (fallback to temp if cwd missing)
    if (!DEBUG_LOG_FILE) {
      if (notification.cwd) {
        DEBUG_LOG_FILE = getDebugLogPath(notification.cwd);
      } else {
        DEBUG_LOG_FILE = getTempLogPath();
      }
      debugLog("🚀 Codex notify script invoked (late init)", {
        argv: process.argv,
        cwd: process.cwd(),
        logLocation: DEBUG_LOG_FILE,
      });
    }

    debugLog("📝 Debug log file", { DEBUG_LOG_FILE });
    debugLog("📦 Raw notification JSON received", {
      length: notificationJson.length,
      raw: notificationJson,
    });
    debugLog("✅ Notification parsed successfully", {
      parsedData: notification,
    });

    // Only handle agent-turn-complete events
    if (notification.type !== "agent-turn-complete") {
      debugLog("⏭️ Ignoring non-agent-turn-complete event", {
        type: notification.type,
      });
      return;
    }

    debugLog("🎯 Event type validated", { type: notification.type });

    // Use workspace-specific directory (from cwd in notification)
    // This prevents conflicts when multiple VS Code instances are running
    const workspaceDir = notification.cwd;
    if (!workspaceDir) {
      const errorMsg = "Missing cwd in notification";
      debugLog("❌ ERROR: " + errorMsg, { notification });
      console.error("FlightPath Codex Notify: " + errorMsg);
      process.exit(1);
    }

    debugLog("📁 Workspace directory identified", { workspaceDir });

    const notifyDir = path.join(
      workspaceDir,
      ".flightpath",
      "temp",
      "codex-notifications"
    );

    // Ensure notification directory exists
    if (!fs.existsSync(notifyDir)) {
      fs.mkdirSync(notifyDir, { recursive: true });
      debugLog("📁 Created notification directory", { notifyDir });
    }

    // Write notification file (named by thread-id for easy lookup)
    const threadId = notification["thread-id"];
    if (!threadId) {
      const errorMsg = "Missing thread-id in notification";
      debugLog("❌ ERROR: " + errorMsg, { notification });
      console.error("FlightPath Codex Notify: " + errorMsg);
      process.exit(1);
    }

    debugLog("🔑 Thread ID extracted", { threadId });

    const notifyFile = path.join(notifyDir, `${threadId}.json`);

    // Create notification data
    const notifyData = {
      timestamp: Date.now(),
      threadId: threadId,
      turnId: notification["turn-id"],
      status: "completed",
      cwd: notification.cwd,
      lastMessage: notification["last-assistant-message"],
      inputMessages: notification["input-messages"],
    };

    // Write to file (FlightPath will read and delete)
    fs.writeFileSync(notifyFile, JSON.stringify(notifyData, null, 2));
    debugLog("✅ Notification file written", { notifyFile, notifyData });
    debugLog("✅ Notify handler completed successfully");
  } catch (error) {
    debugLog("❌ ERROR: Exception during processing", {
      message: error.message,
      stack: error.stack,
      notificationJson: notificationJson,
    });
    console.error(
      "FlightPath Codex Notify: Error processing notification:",
      error.message
    );
    process.exit(1);
  }
}

// Run main handler
main();
