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
 * - Notification: Gemini's system alert hook; ToolPermission alerts are treated
 *   as FlightPath permission-request events
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
const {
  initializeLogger,
  readStdinJson,
  maybeWriteHookArtifact,
  dispatchPermissionRequest,
  requireNotifyDir,
  requireSessionId,
  ensureNotifyDir,
  buildNotifyFilePath,
} = require("./flightpath-hook-utils");

const SCRIPT_NAME = "flightpath-gemini-hook";
const SCRIPT_PREFIX = "FlightPath Gemini Hook";

function main() {
  const notifyDir = process.argv[2];
  const encodedDecisionHook = process.argv[3];
  const debugLog = initializeLogger(SCRIPT_NAME, notifyDir);

  debugLog("🚀 Gemini hook script invoked", {
    argv: process.argv,
    argvLength: process.argv.length,
    cwd: process.cwd(),
    env_keys: Object.keys(process.env),
  });

  requireNotifyDir(SCRIPT_PREFIX, debugLog);

  debugLog("📁 Hook configuration", { notifyDir });

  readStdinJson(SCRIPT_PREFIX, debugLog, (hookInput) => {
    const hookEvent = hookInput.hook_event_name;
    debugLog("🎯 Hook event identified", {
      hookEvent,
      allFields: Object.keys(hookInput),
    });

    const HANDLED_EVENTS = new Set([
      "SessionStart",
      "AfterAgent",
      "BeforeTool",
      "AfterTool",
      "Notification",
    ]);

    if (!HANDLED_EVENTS.has(hookEvent)) {
      debugLog("⏭️ Ignoring non-handled hook event", { hookEvent });
      process.exit(0);
    }

    const sessionId = hookInput.session_id;
    const toolName = hookInput.tool_name || hookInput.tool?.name;
    const isPermissionNotification =
      hookEvent === "Notification" &&
      hookInput.notification_type === "ToolPermission";

    // Map Gemini-native event → logical event
    const LOGICAL_EVENT_MAP = {
      SessionStart: "sessionStart",
      AfterAgent: "stop",
      BeforeTool: "preToolUse",
      AfterTool: "postToolUse",
    };
    const logicalEvent = isPermissionNotification
      ? "permissionRequest"
      : LOGICAL_EVENT_MAP[hookEvent];
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

    if (hookEvent === "Notification") {
      if (!isPermissionNotification) {
        debugLog("⏭️ Ignoring non-permission notification", {
          notificationType: hookInput.notification_type,
        });
        process.exit(0);
      }

      dispatchPermissionRequest(
        encodedDecisionHook,
        hookInput,
        hookEvent,
        debugLog
      );
    }

    // BeforeTool / AfterTool don't need notification files
    if (hookEvent === "BeforeTool" || hookEvent === "AfterTool") {
      debugLog(`✅ Hook ${hookEvent} completed`);
      process.exit(0);
    }

    requireSessionId(sessionId, hookEvent, hookInput, SCRIPT_PREFIX, debugLog);

    debugLog("🔑 Session ID extracted", { hookEvent, sessionId });

    ensureNotifyDir(notifyDir, debugLog);

    // Normalize AfterAgent → "Stop" so NotificationMonitorBase works unchanged
    const isCompletion = hookEvent === "AfterAgent";
    const notifyFile = buildNotifyFilePath(notifyDir, sessionId, !isCompletion);

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
