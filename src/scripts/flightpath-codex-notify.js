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
const {
  isDiagnosticLogsEnabled,
  getDebugLogPath,
  createLogger,
} = require("./flightpath-hook-utils");

const SCRIPT_NAME = "flightpath-codex-notify";
let debugLog = createLogger(null); // Will be re-initialized after parsing notification

/**
 * Main handler function
 */
function main() {
  // Initialize debug logging only when diagnostic logs are enabled.
  // The workspace is available from the notification's cwd field.
  let notificationJson = process.argv[2];
  try {
    if (notificationJson) {
      const notification = JSON.parse(notificationJson);
      if (notification.cwd && isDiagnosticLogsEnabled(notification.cwd)) {
        const logsDir = path.join(notification.cwd, ".flightpath", "logs");
        debugLog = createLogger(getDebugLogPath(logsDir, SCRIPT_NAME));
      }
    }
    debugLog("🚀 Codex notify script invoked", {
      argv: process.argv,
      argvLength: process.argv.length,
      cwd: process.cwd(),
    });
  } catch (err) {
    // Ignore errors — logger stays as no-op
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

    const safeThreadId = path.basename(threadId); // strip any directory components
    const notifyFile = path.join(notifyDir, `${safeThreadId}.json`);

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
