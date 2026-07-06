#!/usr/bin/env node

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
    case "PreToolUse":
      return "preToolUse";
    case "PostToolUse":
      return "postToolUse";
    case "PostInvocation":
    case "Stop":
      return "stop";
    default:
      return undefined;
  }
}

function main() {
  const notifyDir = process.argv[2];
  const encodedDecisionHook = process.argv[3];
  const debugLog = initializeLogger(SCRIPT_NAME, notifyDir);

  requireNotifyDir(SCRIPT_PREFIX, debugLog);

  readStdinJson(SCRIPT_PREFIX, debugLog, (hookInput) => {
    const hookEvent = getStringField(hookInput, [
      "hookEventName",
      "hook_event_name",
      "event",
    ]);
    if (!hookEvent) {
      process.stdout.write("{}");
      process.exit(0);
    }

    const sessionId = getStringField(hookInput, [
      "conversationId",
      "conversation_id",
    ]);
    const toolName = getStringField(hookInput, [
      "toolName",
      "tool_name",
    ]);

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

    if (hookEvent === "PreToolUse" && encodedDecisionHook) {
      dispatchPermissionRequest(
        encodedDecisionHook,
        hookInput,
        hookEvent,
        debugLog
      );
    }

    if (hookEvent === "PostInvocation" || hookEvent === "Stop") {
      requireSessionId(sessionId, hookEvent, hookInput, SCRIPT_PREFIX, debugLog);
      ensureNotifyDir(notifyDir, debugLog);
      const notifyFile = buildNotifyFilePath(notifyDir, sessionId, false);
      fs.writeFileSync(
        notifyFile,
        JSON.stringify(
          {
            timestamp: Date.now(),
            sessionId,
            status: "completed",
            hookEvent: "Stop",
            rawHookEvent: hookEvent,
            rawHookData: hookInput,
          },
          null,
          2
        )
      );
      process.stdout.write("{}");
      process.exit(0);
    }

    if (hookEvent === "PreInvocation") {
      process.stdout.write("{}");
      process.exit(0);
    }

    process.exit(0);
  });
}

main();
