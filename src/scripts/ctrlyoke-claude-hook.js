#!/usr/bin/env node

/**
 * ctrlyoke Claude Hook Handler
 *
 * This script is executed by Claude CLI when hook events occur.
 * It receives hook input JSON via stdin and writes a notification file
 * that ctrlyoke monitors for session discovery and completion detection.
 *
 * Supported hook events:
 * - SessionStart: Called when new session starts (provides session ID immediately)
 * - Stop: Called when execution completes (for completion detection)
 * - Notification: Side-effect-only event forwarded as an opt-in hook artifact
 *
 * Usage (configured by ctrlyoke via --settings):
 *   claude --settings '{"hooks":{"SessionStart":[...], "Stop":[...]}}' ...
 *
 * Hook input format (from Claude via stdin):
 * {
 *   "session_id": "abc123",
 *   "transcript_path": "~/.claude/projects/.../session.jsonl",
 *   "permission_mode": "default",
 *   "hook_event_name": "SessionStart" | "Stop" | "Notification",
 *   "message": "Notification text" (Notification only),
 *   "title": "Notification title" (Notification only),
 *   "notification_type": "permission_prompt" (Notification only),
 *   "session_start_hook_active": true,
 *   "stop_hook_active": true
 * }
 *
 * Notification directory is passed as first command-line argument.
 *
 * Debug logging: All hook data logged to <workspace>/.ctrlyoke/logs/ctrlyoke-claude-hook-debug.log
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
  buildErrorNotifyFilePath,
  STANDARD_LOGICAL_EVENT_MAP,
  STANDARD_HANDLED_EVENTS,
  normalizeNotificationDetails,
} = require("./ctrlyoke-hook-utils");

const SCRIPT_NAME = "ctrlyoke-claude-hook";
const SCRIPT_PREFIX = "ctrlyoke Claude Hook";
const HANDLED_EVENTS = new Set([...STANDARD_HANDLED_EVENTS, "StopFailure"]);
const LOGICAL_EVENT_MAP = {
  ...STANDARD_LOGICAL_EVENT_MAP,
  StopFailure: "error",
};

function main() {
  const notifyDir = process.argv[2];
  const encodedDecisionHook = process.argv[3];
  const debugLog = initializeLogger(SCRIPT_NAME, notifyDir);

  debugLog("🚀 Claude hook script invoked", {
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

    if (!HANDLED_EVENTS.has(hookEvent)) {
      debugLog("⏭️ Ignoring unhandled hook event", { hookEvent });
      process.exit(0);
    }

    const sessionId = hookInput.session_id;
    const toolName = hookInput.tool_name || hookInput.tool?.name;

    // Write hook artifact for preToolUse, postToolUse, userPromptSubmit,
    // permissionRequest — before any stdout/notify file activity.
    // NOTE: PermissionRequest is a decision hook — we must NOT produce stdout.
    const logicalEvent = LOGICAL_EVENT_MAP[hookEvent];
    if (logicalEvent && notifyDir) {
      const artifactExtras =
        logicalEvent === "notification"
          ? normalizeNotificationDetails(hookInput)
          : undefined;
      maybeWriteHookArtifact(
        logicalEvent,
        hookEvent,
        hookInput,
        notifyDir,
        sessionId,
        toolName,
        debugLog,
        artifactExtras
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
    if (
      hookEvent === "PreToolUse" ||
      hookEvent === "PostToolUse" ||
      hookEvent === "UserPromptSubmit" ||
      hookEvent === "Notification"
    ) {
      debugLog(`✅ Hook ${hookEvent} completed`);
      process.exit(0);
    }

    // SessionStart, Stop, and StopFailure require session_id + notification file
    requireSessionId(sessionId, hookEvent, hookInput, SCRIPT_PREFIX, debugLog);

    debugLog("🔑 Session ID extracted", { hookEvent, sessionId });

    ensureNotifyDir(notifyDir, debugLog);

    const notifyFile =
      hookEvent === "StopFailure"
        ? buildErrorNotifyFilePath(notifyDir, sessionId)
        : buildNotifyFilePath(
            notifyDir,
            sessionId,
            hookEvent === "SessionStart"
          );

    const notifyData = {
      timestamp: Date.now(),
      sessionId,
      status:
        hookEvent === "SessionStart"
          ? "started"
          : hookEvent === "StopFailure"
            ? "error"
            : "completed",
      hookEvent,
      transcriptPath: hookInput.transcript_path,
      permissionMode: hookInput.permission_mode,
      sessionStartHookActive: hookInput.session_start_hook_active,
      stopHookActive: hookInput.stop_hook_active,
      rawHookData: hookInput,
    };

    fs.writeFileSync(notifyFile, JSON.stringify(notifyData, null, 2));
    debugLog("✅ Notification file written", { notifyFile, notifyData });
    debugLog(`✅ Hook ${hookEvent} completed successfully`);
    process.exit(0);
  });
}

main();
