#!/usr/bin/env node

/**
 * FlightPath Qwen Code Hook Handler
 *
 * This script is executed by Qwen Code CLI when hook events occur.
 * It receives hook input JSON via stdin and writes a notification file
 * that FlightPath monitors for session discovery and completion detection.
 *
 * Supported hook events:
 * - SessionStart: Called when new session starts (provides session ID immediately)
 * - Stop: Called when execution completes
 *
 * Usage (configured by FlightPath via .qwen/settings.json, requires --experimental-hooks):
 *   { "hooks": { "SessionStart": [...], "Stop": [...] } }
 *
 * Hook input format (from Qwen Code via stdin):
 * {
 *   "session_id": "abc123",
 *   "transcript_path": "~/.qwen/projects/.../session.jsonl",
 *   "cwd": "/workspace",
 *   "permission_mode": "default",
 *   "hook_event_name": "SessionStart" | "Stop",
 *   "stop_hook_active": true,
 *   "last_assistant_message": "..."
 * }
 *
 * Notification directory is passed as first command-line argument.
 *
 * Debug logging: All hook data logged to <workspace>/.flightpath/logs/flightpath-qwen-hook-debug.log
 */

const fs = require("fs");
const {
  initializeLogger,
  readStdinJson,
  maybeWriteHookArtifact,
  dispatchPermissionRequest,
  logInvocation,
  requireNotifyDir,
  requireSessionId,
  ensureNotifyDir,
  buildNotifyFilePath,
  STANDARD_LOGICAL_EVENT_MAP,
  STANDARD_HANDLED_EVENTS,
} = require("./flightpath-hook-utils");

const SCRIPT_NAME = "flightpath-qwen-hook";
const SCRIPT_PREFIX = "FlightPath Qwen Hook";

function main() {
  const notifyDir = process.argv[2];
  const encodedDecisionHook = process.argv[3];

  // Unconditional invocation log — written before any flag checks so we can confirm
  // the hook script is being called at all, regardless of diagnostic settings.
  logInvocation(SCRIPT_NAME, notifyDir);

  const debugLog = initializeLogger(SCRIPT_NAME, notifyDir);

  debugLog("🚀 Qwen hook script invoked", {
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

    if (!STANDARD_HANDLED_EVENTS.has(hookEvent)) {
      debugLog("⏭️ Ignoring unhandled hook event", { hookEvent });
      process.exit(0);
    }

    const sessionId = hookInput.session_id;
    const toolName = hookInput.tool_name || hookInput.tool?.name;

    const logicalEvent = STANDARD_LOGICAL_EVENT_MAP[hookEvent];
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

    if (hookEvent === "PermissionRequest") {
      dispatchPermissionRequest(
        encodedDecisionHook,
        hookInput,
        hookEvent,
        debugLog
      );
    }

    // Events that don't need notification file I/O
    if (hookEvent === "PreToolUse" || hookEvent === "PostToolUse") {
      debugLog(`✅ Hook ${hookEvent} completed`);
      process.exit(0);
    }

    requireSessionId(sessionId, hookEvent, hookInput, SCRIPT_PREFIX, debugLog);

    debugLog("🔑 Session ID extracted", { hookEvent, sessionId });

    ensureNotifyDir(notifyDir, debugLog);

    const isStartEvent =
      hookEvent === "SessionStart" || hookEvent === "UserPromptSubmit";
    const notifyFile = buildNotifyFilePath(notifyDir, sessionId, isStartEvent);

    const notifyData = {
      timestamp: Date.now(),
      sessionId,
      status: isStartEvent ? "started" : "completed",
      hookEvent,
      transcriptPath: hookInput.transcript_path,
      permissionMode: hookInput.permission_mode,
      stopHookActive: hookInput.stop_hook_active,
    };

    fs.writeFileSync(notifyFile, JSON.stringify(notifyData, null, 2));
    debugLog("✅ Notification file written", { notifyFile, notifyData });
    debugLog(`✅ Hook ${hookEvent} completed successfully`);
    process.exit(0);
  });
}

main();
