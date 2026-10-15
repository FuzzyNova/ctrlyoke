#!/usr/bin/env node

/**
 * ctrlyoke Antigravity (agy) Hook Handler
 *
 * Executed by the Antigravity CLI (`agy`) when hook events occur. Receives the
 * hook payload as JSON on stdin and writes a notification file that ctrlyoke
 * monitors for session discovery and completion detection.
 *
 * agy specifics that differ from the Claude/Codex hooks:
 * - agy does NOT include the event name in the stdin payload. ctrlyoke passes
 *   the native event name as a command-line arg (argv[3]) instead — each event
 *   has its own command string in hooks.json.
 * - agy runs hook commands with cwd = ~/.gemini/config and naive whitespace
 *   splitting (no shell quote processing), so the command is emitted unquoted
 *   with forward-slash absolute paths (see AntigravityNotificationMonitor).
 *
 * Supported native events: PreInvocation, PostInvocation, Stop, PreToolUse,
 * PostToolUse.
 *
 * Usage (configured by ctrlyoke, written to ~/.gemini/config/hooks.json):
 *   node <script> <notifyDir> <NativeEvent>
 *
 * argv[2] = notification directory
 * argv[3] = native event name (PreInvocation | PostInvocation | Stop | ...)
 *
 * Hook stdin payload shape (agy):
 *   PreInvocation/PostInvocation: { conversationId, invocationNum, modelName,
 *     transcriptPath, artifactDirectoryPath, workspacePaths, initialNumSteps }
 *   Stop: { conversationId, terminationReason, fullyIdle, executionNum, ... }
 *
 * Hook stdout contract: emit {} for invocation/stop/tool notification hooks.
 *
 * Debug logging: <workspace>/.ctrlyoke/logs/ctrlyoke-antigravity-hook-debug.log
 */

const fs = require("fs");
const path = require("path");
const {
  initializeLogger,
  readStdinJson,
  maybeWriteHookArtifact,
  requireNotifyDir,
  requireSessionId,
  ensureNotifyDir,
  buildNotifyFilePath,
} = require("./ctrlyoke-hook-utils");

const SCRIPT_NAME = "ctrlyoke-antigravity-hook";
const SCRIPT_PREFIX = "ctrlyoke Antigravity Hook";

function getStringField(input, keys) {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function getLogicalEvent(nativeEvent) {
  switch (nativeEvent) {
    case "PreInvocation":
      return "sessionStart";
    case "PreToolUse":
      return "preToolUse";
    case "PostToolUse":
      return "postToolUse";
    case "Stop":
      return "stop";
    // PostInvocation fires per LLM invocation (multiple times per turn when
    // tool calls happen), so it is NOT a completion signal — Stop is.
    default:
      return undefined;
  }
}

function main() {
  const notifyDir = process.argv[2];
  const nativeEventArg = process.argv[3];
  const registeredWorkspaceRoot = process.argv[4];
  const debugLog = initializeLogger(SCRIPT_NAME, notifyDir);

  debugLog("🚀 Antigravity hook script invoked", {
    argv: process.argv,
    argvLength: process.argv.length,
    cwd: process.cwd(),
    nativeEventArg,
    registeredWorkspaceRoot,
  });

  requireNotifyDir(SCRIPT_PREFIX, debugLog);

  debugLog("📁 Hook configuration", {
    notifyDir,
    nativeEventArg,
    registeredWorkspaceRoot,
  });

  readStdinJson(SCRIPT_PREFIX, debugLog, (hookInput) => {
    const payloadWorkspacePaths = Array.isArray(hookInput.workspacePaths)
      ? hookInput.workspacePaths
      : [];
    const normalizeWorkspacePath = (workspacePath) => {
      const normalized = path.resolve(workspacePath);
      return process.platform === "win32"
        ? normalized.toLowerCase()
        : normalized;
    };
    if (
      !registeredWorkspaceRoot ||
      !payloadWorkspacePaths.some(
        (workspacePath) =>
          typeof workspacePath === "string" &&
          normalizeWorkspacePath(workspacePath) ===
            normalizeWorkspacePath(registeredWorkspaceRoot)
      )
    ) {
      debugLog("⏭️ Workspace mismatch — emitting {} and exiting", {
        registeredWorkspaceRoot,
        payloadWorkspacePaths,
      });
      process.stdout.write("{}");
      process.exit(0);
    }

    // agy does not put the event name in the payload — trust argv[3], falling
    // back to any payload field for forward-compat.
    const hookEvent =
      nativeEventArg ||
      getStringField(hookInput, ["hookEventName", "hook_event_name", "event"]);

    debugLog("🎯 Hook event identified", {
      hookEvent,
      source: nativeEventArg ? "argv" : "stdin",
      allFields: Object.keys(hookInput),
    });

    if (!hookEvent) {
      debugLog("⏭️ No event name resolved — emitting {} and exiting", {
        hookInput,
      });
      process.stdout.write("{}");
      process.exit(0);
    }

    const sessionId = getStringField(hookInput, [
      "conversationId",
      "conversation_id",
    ]);
    const toolName = getStringField(hookInput, ["toolName", "tool_name"]);

    debugLog("🔑 Session ID + tool extracted", {
      hookEvent,
      sessionId,
      toolName,
    });

    const logicalEvent = getLogicalEvent(hookEvent);
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

    // PreInvocation → session start notification file
    if (hookEvent === "PreInvocation") {
      if (sessionId && notifyDir) {
        ensureNotifyDir(notifyDir, debugLog);
        const notifyFile = buildNotifyFilePath(notifyDir, sessionId, true);
        if (notifyFile) {
          const notifyData = {
            timestamp: Date.now(),
            runId: process.env.CTRLYOKE_RUN_ID || undefined,
            sessionId,
            status: "started",
            hookEvent: "PreInvocation",
            rawHookEvent: hookEvent,
            transcriptPath: getStringField(hookInput, [
              "transcriptPath",
              "transcript_path",
            ]),
            rawHookData: hookInput,
          };
          fs.writeFileSync(notifyFile, JSON.stringify(notifyData, null, 2));
          debugLog("✅ Start notification file written", {
            notifyFile,
            notifyData,
          });
        }
      } else {
        debugLog("⚠️ PreInvocation missing sessionId/notifyDir — no file", {
          hasSessionId: Boolean(sessionId),
          hasNotifyDir: Boolean(notifyDir),
        });
      }
      process.stdout.write("{}");
      process.exit(0);
    }

    // Stop → completion notification file (fires once when the agent goes
    // idle after a turn; PostInvocation is deliberately NOT used here).
    if (hookEvent === "Stop") {
      requireSessionId(
        sessionId,
        hookEvent,
        hookInput,
        SCRIPT_PREFIX,
        debugLog
      );
      ensureNotifyDir(notifyDir, debugLog);
      const notifyFile = buildNotifyFilePath(notifyDir, sessionId, false);
      const notifyData = {
        timestamp: Date.now(),
        runId: process.env.CTRLYOKE_RUN_ID || undefined,
        sessionId,
        status: "completed",
        hookEvent: "Stop",
        rawHookEvent: hookEvent,
        rawHookData: hookInput,
      };
      fs.writeFileSync(notifyFile, JSON.stringify(notifyData, null, 2));
      debugLog("✅ Completion notification file written", {
        notifyFile,
        notifyData,
      });
      process.stdout.write("{}");
      process.exit(0);
    }

    // PreToolUse/PostToolUse with no decision hook, or any other event.
    debugLog(`✅ Hook ${hookEvent} completed (no notification file)`);
    process.stdout.write("{}");
    process.exit(0);
  });
}

main();
