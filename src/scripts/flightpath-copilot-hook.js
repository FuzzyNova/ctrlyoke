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
 *     "agentStop": [{"type": "command", "bash": "node <script> <dir> agentStop"}]
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
 *   "reason": "complete"      // agentStop only
 * }
 *
 * Arguments:
 * - argv[2]: Notification directory
 * - argv[3]: Hook type (sessionStart | agentStop)
 *
 * Debug logging: All hook data logged to <workspace>/.flightpath/logs/flightpath-copilot-hook-debug.log
 */

const fs = require("fs");
const path = require("path");
const {
  initializeLogger,
  readStdinJson,
  maybeWriteHookArtifact,
  dispatchPermissionRequest,
  ensureNotifyDir,
  buildNotifyFilePath,
} = require("./flightpath-hook-utils");

const SCRIPT_NAME = "flightpath-copilot-hook";
const SCRIPT_PREFIX = "FlightPath Copilot Hook";

function main() {
  const notifyDir = process.argv[2];
  const encodedDecisionHook = process.argv[4];
  const debugLog = initializeLogger(SCRIPT_NAME, notifyDir);

  debugLog("🚀 Hook script invoked", {
    argv: process.argv,
    argvLength: process.argv.length,
    cwd: process.cwd(),
    env_keys: Object.keys(process.env),
  });

  // Arguments: node <script> <notifyDir> <hookType>
  if (process.argv.length < 4) {
    const errorMsg = `Missing required arguments (notifyDir and hookType). Received ${process.argv.length - 1} argument(s): ${process.argv.slice(2).join(", ")}`;
    debugLog("❌ FATAL ERROR: " + errorMsg, {
      argv: process.argv,
      expected: "node <script> <notifyDir> <hookType>",
    });
    console.error(`${SCRIPT_PREFIX}: ${errorMsg}`);
    process.exit(1);
  }

  const hookType = process.argv[3];
  debugLog("📁 Hook configuration", { notifyDir, hookType });

  readStdinJson(SCRIPT_PREFIX, debugLog, (hookInput) => {
    debugLog(`✅ JSON parsed successfully for ${hookType}`, {
      hookType,
      parsedData: hookInput,
    });

    const sessionId = hookInput.sessionId || hookInput.session_id;
    const toolName =
      hookInput.toolName || hookInput.tool_name || hookInput.tool?.name;

    if (sessionId) {
      debugLog("🔑 Session ID found!", { hookType, sessionId });
    } else {
      debugLog("⚠️ No session ID found in hook data", {
        hookType,
        availableFields: Object.keys(hookInput),
      });
    }

    // Map copilot hook type to logical event name
    const LOGICAL_EVENT_MAP = {
      sessionStart: "sessionStart",
      agentStop: "stop",
      preToolUse: "preToolUse",
      postToolUse: "postToolUse",
      userPromptSubmitted: "userPromptSubmit",
      permissionRequest: "permissionRequest",
    };
    const logicalEvent = LOGICAL_EVENT_MAP[hookType];
    if (logicalEvent && notifyDir) {
      maybeWriteHookArtifact(
        logicalEvent,
        hookType,
        hookInput,
        notifyDir,
        sessionId,
        toolName,
        debugLog
      );
    }

    if (hookType === "permissionRequest") {
      dispatchPermissionRequest(
        encodedDecisionHook,
        hookInput,
        hookType,
        debugLog
      );
    }

    if (hookType === "sessionStart" || hookType === "agentStop") {
      ensureNotifyDir(notifyDir, debugLog);

      // Use same file naming convention as flightpath-claude-hook.js:
      //   sessionStart → {runId|sessionId}-start.json  (runId when FLIGHTPATH_RUN_ID set)
      //   agentStop    → {sessionId}-stop.json
      const notifyFile =
        buildNotifyFilePath(notifyDir, sessionId, hookType === "sessionStart") ||
        path.join(notifyDir, `${hookType}-${Date.now()}.json`);

      const notifyData = {
        timestamp: Date.now(),
        sessionId: sessionId || null,
        status: hookType === "sessionStart" ? "started" : "completed",
        // hookEvent matches Claude's format: "SessionStart" | "Stop"
        hookEvent: hookType === "sessionStart" ? "SessionStart" : "Stop",
        cwd: hookInput.cwd,
        rawHookData: hookInput,
      };

      fs.writeFileSync(notifyFile, JSON.stringify(notifyData, null, 2));
      debugLog("✅ Notification file written", { notifyFile, notifyData });
    } else {
      debugLog(`⏭️ Hook ${hookType} processed (not writing notification)`, {
        hookType,
        sessionId: sessionId || "none",
      });
    }

    debugLog(`✅ Hook ${hookType} completed successfully`);
    process.exit(0);
  });
}

main();
