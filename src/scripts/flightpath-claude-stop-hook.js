#!/usr/bin/env node

/**
 * FlightPath Claude Stop Hook Handler
 *
 * This script is executed by Claude CLI when Stop hook events occur.
 * It receives hook input JSON via stdin and writes a notification file
 * that FlightPath monitors for completion detection.
 *
 * Usage (configured by FlightPath via --settings):
 *   claude --settings '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"node <this-script> <notify-dir>"}]}]}}' ...
 *
 * Hook input format (from Claude via stdin):
 * {
 *   "session_id": "abc123",
 *   "transcript_path": "~/.claude/projects/.../session.jsonl",
 *   "permission_mode": "default",
 *   "hook_event_name": "Stop",
 *   "stop_hook_active": true
 * }
 *
 * Notification directory is passed as first command-line argument.
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");

/**
 * Main handler function
 */
function main() {
  // Notification directory passed as first argument
  if (process.argv.length < 3) {
    console.error(
      "FlightPath Claude Stop Hook: No notification directory provided"
    );
    process.exit(1);
  }

  const notifyDir = process.argv[2];

  // Read hook input JSON from stdin (Claude hook format)
  let inputData = "";
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  rl.on("line", (line) => {
    inputData += line;
  });

  rl.on("close", () => {
    try {
      // Parse hook input
      const hookInput = JSON.parse(inputData);

      // Validate this is a Stop hook event
      if (hookInput.hook_event_name !== "Stop") {
        // Silently ignore other hook events (shouldn't happen, but defensive)
        process.exit(0);
      }

      // Extract session ID
      const sessionId = hookInput.session_id;
      if (!sessionId) {
        console.error(
          "FlightPath Claude Stop Hook: Missing session_id in hook input"
        );
        process.exit(1);
      }

      // Ensure notification directory exists
      if (!fs.existsSync(notifyDir)) {
        fs.mkdirSync(notifyDir, { recursive: true });
      }

      // Write notification file (named by session_id for easy lookup)
      const notifyFile = path.join(notifyDir, `${sessionId}.json`);

      // Create notification data
      const notifyData = {
        timestamp: Date.now(),
        sessionId: sessionId,
        status: "completed",
        hookEvent: "Stop",
        transcriptPath: hookInput.transcript_path,
        permissionMode: hookInput.permission_mode,
        stopHookActive: hookInput.stop_hook_active,
      };

      // Write to file (FlightPath will read and delete)
      fs.writeFileSync(notifyFile, JSON.stringify(notifyData, null, 2));

      // Optional: Log to stderr for debugging (won't interfere with hook processing)
      // console.error(`FlightPath Claude Stop Hook: Wrote notification to ${notifyFile}`);

      // Exit 0 to allow Claude to stop (approve the stoppage)
      process.exit(0);
    } catch (error) {
      console.error(
        "FlightPath Claude Stop Hook: Error processing hook input:",
        error.message
      );
      // Exit 1 to signal error (Claude will show this in debug mode)
      process.exit(1);
    }
  });
}

main();
