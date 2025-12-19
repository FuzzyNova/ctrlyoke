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
 */

const fs = require("fs");
const path = require("path");

/**
 * Main handler function
 */
function main() {
  // Codex passes notification as first argument (JSON string)
  if (process.argv.length < 3) {
    console.error("FlightPath Codex Notify: No notification argument provided");
    process.exit(1);
  }

  const notificationJson = process.argv[2];

  try {
    // Parse notification
    const notification = JSON.parse(notificationJson);

    // Only handle agent-turn-complete events
    if (notification.type !== "agent-turn-complete") {
      // Silently ignore other event types
      return;
    }

    // Use workspace-specific directory (from cwd in notification)
    // This prevents conflicts when multiple VS Code instances are running
    const workspaceDir = notification.cwd;
    if (!workspaceDir) {
      console.error("FlightPath Codex Notify: Missing cwd in notification");
      process.exit(1);
    }

    const notifyDir = path.join(
      workspaceDir,
      ".flightpath",
      "temp",
      "codex-notifications"
    );

    // Ensure notification directory exists
    if (!fs.existsSync(notifyDir)) {
      fs.mkdirSync(notifyDir, { recursive: true });
    }

    // Write notification file (named by thread-id for easy lookup)
    const threadId = notification["thread-id"];
    if (!threadId) {
      console.error(
        "FlightPath Codex Notify: Missing thread-id in notification"
      );
      process.exit(1);
    }

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

    // Optional: Log to stderr for debugging (won't interfere with stdout)
    // console.error(`FlightPath Codex Notify: Wrote notification to ${notifyFile}`);
  } catch (error) {
    console.error(
      "FlightPath Codex Notify: Error processing notification:",
      error.message
    );
    process.exit(1);
  }
}

// Run main handler
main();
