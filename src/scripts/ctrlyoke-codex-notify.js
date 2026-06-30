#!/usr/bin/env node

/**
 * ctrlyoke Codex Hook Handler
 *
 * This script is executed by Codex CLI when hook events occur.
 * It receives hook input JSON via stdin and writes a notification file
 * that ctrlyoke monitors for session discovery and completion detection.
 *
 * Supported hook events:
 * - SessionStart: Called when a new session starts (provides session ID immediately)
 * - Stop: Called when execution completes
 *
 * Usage (configured by ctrlyoke via .codex/hooks.json, requires --enable hooks):
 *   { "hooks": { "SessionStart": [{ "matcher": "", "hooks": [{ "type": "command", "command": "node <script> <notifyDir>" }] }], "Stop": [...] } }
 *
 * Hook input format (from Codex via stdin):
 * {
 *   "session_id": "abc123",
 *   "transcript_path": "~/.codex/.../session.jsonl",
 *   "cwd": "/workspace",
 *   "permission_mode": "default",
 *   "hook_event_name": "SessionStart" | "Stop",
 *   "stop_hook_active": true,
 *   "last_assistant_message": "...",
 *   "source": "startup" | "resume" | "clear"
 * }
 *
 * Notification directory is passed as first command-line argument.
 *
 * Debug logging: All hook data logged to <workspace>/.ctrlyoke/logs/ctrlyoke-codex-notify-debug.log
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
} = require("./ctrlyoke-hook-utils");

const SCRIPT_NAME = "ctrlyoke-codex-notify";
const SCRIPT_PREFIX = "ctrlyoke Codex Hook";

function main() {
  const notifyDir = process.argv[2];
  const encodedDecisionHook = process.argv[3];

  // Unconditional invocation log — written before any flag checks so we can confirm
  // the hook script is being called at all, regardless of diagnostic settings.
  logInvocation(SCRIPT_NAME, notifyDir);

  const debugLog = initializeLogger(SCRIPT_NAME, notifyDir);

  debugLog("🚀 Codex hook script invoked", {
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
    if (
      hookEvent === "PreToolUse" ||
      hookEvent === "PostToolUse" ||
      hookEvent === "UserPromptSubmit"
    ) {
      debugLog(`✅ Hook ${hookEvent} completed`);
      process.exit(0);
    }

    requireSessionId(sessionId, hookEvent, hookInput, SCRIPT_PREFIX, debugLog);

    debugLog("🔑 Session ID extracted", { hookEvent, sessionId });

    ensureNotifyDir(notifyDir, debugLog);

    const isStartEvent = hookEvent === "SessionStart";
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
