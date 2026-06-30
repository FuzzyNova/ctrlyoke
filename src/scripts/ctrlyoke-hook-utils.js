/**
 * ctrlyoke Hook Script Shared Utilities
 *
 * Common functions used by all hook/notify scripts (Copilot, Claude, Codex).
 * Plain CommonJS with only Node.js built-in dependencies.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

/**
 * Get debug log file path in a specified logs directory.
 * Ensures the logs directory exists before returning the path.
 *
 * @param {string} logsDir - Directory where log files should be written
 * @param {string} scriptName - Base name for the log file (e.g., 'ctrlyoke-copilot-hook')
 * @returns {string} Full path to the debug log file
 */
function getDebugLogPath(logsDir, scriptName) {
  try {
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    return path.join(logsDir, `${scriptName}-debug.log`);
  } catch (err) {
    // If anything fails, use temp directory fallback
    return getTempLogPath(scriptName);
  }
}

/**
 * Get debug log file path in system temp directory (fallback).
 *
 * @param {string} scriptName - Base name for the log file
 * @returns {string} Full path to the temp debug log file
 */
function getTempLogPath(scriptName) {
  return path.join(os.tmpdir(), `${scriptName}-debug.log`);
}

/**
 * Create a debug logger function bound to a specific log file path.
 * The returned function appends timestamped entries to the log file.
 * All errors are silently swallowed to never interfere with hook execution.
 *
 * @param {string|null} logPath - Path to the log file, or null to create a no-op logger
 * @returns {function(string, object=): void} Logger function accepting (message, data?)
 */
function createLogger(logPath) {
  return function debugLog(message, data) {
    if (!logPath) {
      return;
    }
    try {
      const timestamp = new Date().toISOString();
      let logEntry = `[${timestamp}] ${message}`;
      if (data !== undefined && data !== null) {
        logEntry += "\n" + JSON.stringify(data, null, 2);
      }
      logEntry += "\n---\n";
      fs.appendFileSync(logPath, logEntry);
    } catch (err) {
      // Silently ignore debug logging errors
    }
  };
}

/**
 * Derive the .ctrlyoke/logs/ directory from a notification directory path.
 * Notification directories follow the pattern: <workspace>/.ctrlyoke/temp/<harness>-notifications
 * This navigates up 2 levels to reach .ctrlyoke/, then appends logs/.
 *
 * @param {string} notifyDir - The notification directory path
 * @returns {string} Path to the logs directory
 */
function getLogsDirFromNotifyDir(notifyDir) {
  const ctrlyokeDir = path.join(notifyDir, "..", "..");
  return path.join(ctrlyokeDir, "logs");
}

/**
 * Derive the workspace root from a notification directory path.
 * Notification directories follow the pattern: <workspace>/.ctrlyoke/temp/<harness>-notifications
 * This navigates up 3 levels to reach the workspace root.
 *
 * @param {string} notifyDir - The notification directory path
 * @returns {string} Path to the workspace root
 */
function getWorkspaceRootFromNotifyDir(notifyDir) {
  return path.join(notifyDir, "..", "..", "..");
}

/**
 * Initialize the debug logger for a stdin-based hook script.
 *
 * Checks the CTRLYOKE_DIAGNOSTIC_LOGS environment variable (injected into
 * the CLI process env at spawn time by ctrlyoke) and returns a configured
 * logger when enabled. Returns a no-op logger otherwise — hook scripts must
 * never crash due to logging setup.
 *
 * @param {string} scriptName - Base name for the log file (e.g., 'ctrlyoke-claude-hook')
 * @param {string|undefined} notifyDir - Notification directory path (argv[2])
 * @returns {function(string, object=): void} Configured logger function
 */
function initializeLogger(scriptName, notifyDir) {
  try {
    if (notifyDir && process.env.CTRLYOKE_DIAGNOSTIC_LOGS === "true") {
      const logsDir = getLogsDirFromNotifyDir(notifyDir);
      return createLogger(getDebugLogPath(logsDir, scriptName));
    }
  } catch {
    // Ignore — return no-op logger below
  }
  return createLogger(null);
}

/**
 * Read all stdin as a single JSON object and invoke a callback.
 *
 * Handles readline setup, line buffering, JSON parsing, debug logging,
 * and error reporting. If JSON parsing fails or the callback throws an
 * unhandled exception, logs the error and exits with code 1.
 *
 * The callback receives the parsed hook input object. It may call
 * process.exit() directly for validation errors or success — any
 * uncaught exception it throws is caught here.
 *
 * @param {string} scriptPrefix - Prefix for console.error messages (e.g., 'ctrlyoke Claude Hook')
 * @param {function} debugLog - Logger returned by initializeLogger or createLogger
 * @param {function(object): void} callback - Called with parsed JSON on success
 */
function readStdinJson(scriptPrefix, debugLog, callback) {
  const readline = require("readline");

  debugLog("📥 Starting stdin read...");
  let inputData = "";
  let lineCount = 0;
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  rl.on("line", (line) => {
    lineCount++;
    inputData += line;
    debugLog(`📝 Line ${lineCount} received`, { line, length: line.length });
  });

  rl.on("close", () => {
    debugLog("🔚 Stdin closed", {
      totalLines: lineCount,
      totalLength: inputData.length,
      rawInput: inputData,
    });

    try {
      debugLog("🔍 Attempting to parse JSON...");
      const hookInput = JSON.parse(inputData);
      debugLog("✅ JSON parsed successfully", { parsedData: hookInput });
      callback(hookInput);
    } catch (error) {
      debugLog("❌ ERROR: Exception during processing", {
        message: error.message,
        stack: error.stack,
        inputData,
      });
      console.error(
        `${scriptPrefix}: Error processing hook input:`,
        error.message
      );
      process.exit(1);
    }
  });
}

/**
 * Run a decision hook command with a JSON payload on stdin.
 *
 * Unlike the fire-and-forget pattern used for stop/preToolUse/etc., this
 * function captures the child's stdout and writes it to process.stdout so
 * the harness receives it as the hook decision (allow/deny JSON blob).
 *
 * Exit code 0 with no stdout → harness shows the dialog normally (correct
 * default when the user hook produces no output).
 *
 * @param {string} command - Shell command to run as the decision hook
 * @param {string} payloadJson - JSON string to pipe to the command's stdin
 * @param {function} debugLog - Logger returned by initializeLogger or createLogger
 * @returns {number} Exit code of the child process (0 on success / error)
 */
function runDecisionHook(command, payloadJson, debugLog) {
  const { spawnSync } = require("child_process");
  try {
    debugLog("🔐 runDecisionHook: running decision hook", { command });
    const result = spawnSync(command, {
      input: payloadJson,
      encoding: "utf-8",
      shell: true,
    });
    if (result.stdout) {
      process.stdout.write(result.stdout);
      debugLog("🔐 runDecisionHook: stdout forwarded", {
        stdout: result.stdout,
      });
    }
    const exitCode = result.status ?? 0;
    debugLog("🔐 runDecisionHook: completed", { exitCode });
    return exitCode;
  } catch (err) {
    debugLog("❌ runDecisionHook: error", { error: err.message });
    return 0;
  }
}

/**
 * Build the base fields for a hook artifact from env vars.
 * Returns null if CTRLYOKE_RUN_ID is not set.
 *
 * @returns {object|null} Base artifact object (without hookEvent/nativeHookEvent/toolName/rawHookData)
 */
function buildArtifactBase() {
  const runId = process.env.CTRLYOKE_RUN_ID;
  if (!runId) {
    return null;
  }
  return {
    runId,
    timestamp: Date.now(),
    workflowId: process.env.CTRLYOKE_WORKFLOW_ID || "",
    workflowName: process.env.CTRLYOKE_WORKFLOW_NAME || "",
    promptIndex: parseInt(process.env.CTRLYOKE_PROMPT_INDEX || "0", 10),
    promptName: process.env.CTRLYOKE_PROMPT_NAME || "",
    harnessId: process.env.CTRLYOKE_HARNESS_ID || "",
  };
}

/**
 * Check if a logical hook event is enabled in CTRLYOKE_NOTIFY_HOOK_EVENTS.
 *
 * @param {string} logicalEvent - Logical event name (e.g. "preToolUse")
 * @returns {boolean} True if the event is enabled
 */
function isHookEventEnabled(logicalEvent) {
  const enabled = process.env.CTRLYOKE_NOTIFY_HOOK_EVENTS;
  if (!enabled) {
    return false;
  }
  return enabled.split(",").includes(logicalEvent);
}

/**
 * Write a hook artifact for a hook event if it is enabled.
 *
 * @param {string} logicalEvent - Logical event name (e.g. "preToolUse")
 * @param {string} nativeHookEvent - CLI-native event name (e.g. "PreToolUse")
 * @param {object} hookInput - Parsed hook input object from stdin
 * @param {string} notifyDir - Notification directory path
 * @param {string|undefined} sessionId - Session ID if available
 * @param {string|undefined} toolName - Tool name for preToolUse/postToolUse
 * @param {function} debugLog - Logger function
 */
function maybeWriteHookArtifact(
  logicalEvent,
  nativeHookEvent,
  hookInput,
  notifyDir,
  sessionId,
  toolName,
  debugLog
) {
  if (!isHookEventEnabled(logicalEvent)) {
    return;
  }
  const base = buildArtifactBase();
  if (!base) {
    return;
  }
  const artifact = Object.assign({}, base, {
    hookEvent: logicalEvent,
    nativeHookEvent,
    sessionId: sessionId || undefined,
    toolName: toolName || undefined,
    rawHookData: hookInput,
  });
  writeHookArtifact(notifyDir, artifact, debugLog);
}

/**
 * Write a hook artifact file to the notify directory.
 *
 * Hook scripts call this when CTRLYOKE_NOTIFY_HOOK_EVENTS contains the
 * event name. The file is picked up and deleted by HookEventMonitor in the
 * extension. File naming: `{runId}-hook-{timestamp}-{pid}.json`.
 *
 * @param {string} notifyDir - Notification directory path (from CTRLYOKE_NOTIFY_DIR)
 * @param {object} artifact - The HookArtifact payload to write
 * @param {function} debugLog - Logger returned by initializeLogger or createLogger
 */
function writeHookArtifact(notifyDir, artifact, debugLog) {
  try {
    if (!fs.existsSync(notifyDir)) {
      fs.mkdirSync(notifyDir, { recursive: true });
    }
    const fileName = `${artifact.runId}-hook-${artifact.timestamp}-${process.pid}.json`;
    const filePath = path.join(notifyDir, fileName);
    fs.writeFileSync(filePath, JSON.stringify(artifact));
    if (debugLog) {
      debugLog("📤 writeHookArtifact: wrote artifact", {
        filePath,
        event: artifact.hookEvent,
      });
    }
  } catch (err) {
    if (debugLog) {
      debugLog("❌ writeHookArtifact: error", { error: err.message });
    }
  }
}

/**
 * Standard logical-event mapping shared by the Claude, Codex, and Qwen hook
 * scripts: maps each harness's native hook event name to ctrlyoke's
 * logical event name used for hook-artifact dispatch.
 *
 * @type {Record<string, string>}
 */
const STANDARD_LOGICAL_EVENT_MAP = {
  SessionStart: "sessionStart",
  Stop: "stop",
  PreToolUse: "preToolUse",
  PostToolUse: "postToolUse",
  UserPromptSubmit: "userPromptSubmit",
  PermissionRequest: "permissionRequest",
};

/**
 * Native hook event names handled by the Claude, Codex, and Qwen hook
 * scripts. Any other event is logged and ignored (exit 0).
 *
 * @type {Set<string>}
 */
const STANDARD_HANDLED_EVENTS = new Set(
  Object.keys(STANDARD_LOGICAL_EVENT_MAP)
);

/**
 * Write an unconditional invocation log entry before any flag checks, so
 * hook registration/invocation can be confirmed regardless of diagnostic
 * settings. Falls back to the system temp directory when notifyDir is
 * unavailable. Errors are silently swallowed — must never block hook
 * execution.
 *
 * @param {string} scriptName - Base name for the log file (e.g., 'ctrlyoke-codex-notify')
 * @param {string|undefined} notifyDir - Notification directory path (argv[2])
 */
function logInvocation(scriptName, notifyDir) {
  try {
    const logsDir = notifyDir
      ? path.join(notifyDir, "..", "..", "logs")
      : null;
    const logFile = logsDir
      ? path.join(logsDir, `${scriptName}-debug.log`)
      : path.join(os.tmpdir(), `${scriptName}-invocations.log`);
    if (logsDir) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    fs.appendFileSync(
      logFile,
      `[${new Date().toISOString()}] invoked argv=${JSON.stringify(process.argv)}\n`
    );
  } catch {
    // Never block hook execution on logging
  }
}

/**
 * Validate that a notification directory was provided as argv[2]. Logs and
 * exits the process with code 1 if missing.
 *
 * @param {string} scriptPrefix - Prefix for console.error messages (e.g., 'ctrlyoke Claude Hook')
 * @param {function} debugLog - Logger returned by initializeLogger or createLogger
 */
function requireNotifyDir(scriptPrefix, debugLog) {
  if (process.argv.length < 3) {
    const errorMsg = `No notification directory provided. Received ${process.argv.length - 1} argument(s): ${process.argv.slice(2).join(", ")}`;
    debugLog("❌ FATAL ERROR: " + errorMsg, {
      argv: process.argv,
      expected: "node <script> <notifyDir>",
    });
    console.error(`${scriptPrefix}: ${errorMsg}`);
    process.exit(1);
  }
}

/**
 * Validate that a session ID is present in the hook input. Logs and exits
 * the process with code 1 if missing.
 *
 * @param {string|undefined} sessionId - Session ID extracted from hook input
 * @param {string} hookEvent - Native hook event name (used in the error message)
 * @param {object} hookInput - Parsed hook input object (for debug logging)
 * @param {string} scriptPrefix - Prefix for console.error messages
 * @param {function} debugLog - Logger returned by initializeLogger or createLogger
 */
function requireSessionId(sessionId, hookEvent, hookInput, scriptPrefix, debugLog) {
  if (!sessionId) {
    const errorMsg = `Missing session_id in ${hookEvent} hook input`;
    debugLog("❌ ERROR: " + errorMsg, { hookInput });
    console.error(`${scriptPrefix}: ${errorMsg}`);
    process.exit(1);
  }
}

/**
 * Create the notification directory if it does not already exist.
 *
 * @param {string} notifyDir - Notification directory path
 * @param {function} debugLog - Logger returned by initializeLogger or createLogger
 */
function ensureNotifyDir(notifyDir, debugLog) {
  if (!fs.existsSync(notifyDir)) {
    fs.mkdirSync(notifyDir, { recursive: true });
    debugLog("📁 Created notification directory", { notifyDir });
  }
}

/**
 * Build the start/stop notification file path for a session.
 *
 * Start files use CTRLYOKE_RUN_ID as the filename prefix when set, giving
 * each parallel workflow a uniquely-named start file so waitForSessionStart
 * can do a direct lookup instead of a wildcard scan. Stop files are always
 * keyed by session ID.
 *
 * @param {string} notifyDir - Notification directory path
 * @param {string|null|undefined} sessionId - Session ID, or falsy to skip (returns null)
 * @param {boolean} isStartEvent - True for start files, false for stop files
 * @returns {string|null} Full path to the notification file, or null if sessionId is falsy
 */
function buildNotifyFilePath(notifyDir, sessionId, isStartEvent) {
  if (!sessionId) {
    return null;
  }
  const safeSessionId = path.basename(sessionId);
  const runId = process.env.CTRLYOKE_RUN_ID
    ? path.basename(process.env.CTRLYOKE_RUN_ID)
    : null;
  const startPrefix = runId || safeSessionId;
  return path.join(
    notifyDir,
    isStartEvent ? `${startPrefix}-start.json` : `${safeSessionId}-stop.json`
  );
}

/**
 * Build the error notification file path for a session.
 *
 * @param {string} notifyDir - Notification directory path
 * @param {string|null|undefined} sessionId - Session ID, or falsy to skip
 * @returns {string|null} Full path to the error notification file
 */
function buildErrorNotifyFilePath(notifyDir, sessionId) {
  if (!sessionId) {
    return null;
  }
  return path.join(notifyDir, `${path.basename(sessionId)}-error.json`);
}

/**
 * Handle a permission/decision-request hook event: run the encoded decision
 * hook (if any) and exit the process with its result, or exit 0 if no
 * decision hook is configured. Never returns.
 *
 * @param {string|undefined} encodedDecisionHook - Base64-encoded decision hook command
 * @param {object} hookInput - Parsed hook input object to pipe to the decision hook
 * @param {string} eventLabel - Event name for debug logging (e.g. "PermissionRequest")
 * @param {function} debugLog - Logger returned by initializeLogger or createLogger
 */
function dispatchPermissionRequest(encodedDecisionHook, hookInput, eventLabel, debugLog) {
  if (encodedDecisionHook) {
    const decisionHookCommand = Buffer.from(
      encodedDecisionHook,
      "base64"
    ).toString("utf8");
    process.exit(
      runDecisionHook(decisionHookCommand, JSON.stringify(hookInput), debugLog)
    );
  }
  debugLog(`✅ Hook ${eventLabel} completed`);
  process.exit(0);
}

module.exports = {
  getDebugLogPath,
  getTempLogPath,
  createLogger,
  getLogsDirFromNotifyDir,
  getWorkspaceRootFromNotifyDir,
  initializeLogger,
  readStdinJson,
  runDecisionHook,
  writeHookArtifact,
  buildArtifactBase,
  isHookEventEnabled,
  maybeWriteHookArtifact,
  STANDARD_LOGICAL_EVENT_MAP,
  STANDARD_HANDLED_EVENTS,
  logInvocation,
  requireNotifyDir,
  requireSessionId,
  ensureNotifyDir,
  buildNotifyFilePath,
  buildErrorNotifyFilePath,
  dispatchPermissionRequest,
};
