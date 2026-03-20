/**
 * FlightPath Hook Script Shared Utilities
 *
 * Common functions used by all hook/notify scripts (Copilot, Claude, Codex).
 * Plain CommonJS with only Node.js built-in dependencies.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

/**
 * Check whether diagnostic file logging is enabled for a workspace.
 * The extension writes `.flightpath/.diagnostic-logs` when
 * `flightpath.enableDiagnosticLogs` is true. Hook scripts check this file
 * because they cannot read VS Code settings directly.
 *
 * @param {string|null} workspaceDir - Workspace root (parent of .flightpath/).
 *   Pass null to skip the check (returns false).
 * @returns {boolean} True if the flag file exists.
 */
function isDiagnosticLogsEnabled(workspaceDir) {
  if (!workspaceDir) {
    return false;
  }
  try {
    const flagPath = path.join(workspaceDir, ".flightpath", ".diagnostic-logs");
    return fs.existsSync(flagPath);
  } catch {
    return false;
  }
}

/**
 * Get debug log file path in a specified logs directory.
 * Ensures the logs directory exists before returning the path.
 *
 * @param {string} logsDir - Directory where log files should be written
 * @param {string} scriptName - Base name for the log file (e.g., 'flightpath-copilot-hook')
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
 * Derive the .flightpath/logs/ directory from a notification directory path.
 * Notification directories follow the pattern: <workspace>/.flightpath/temp/<harness>-notifications
 * This navigates up 2 levels to reach .flightpath/, then appends logs/.
 *
 * @param {string} notifyDir - The notification directory path
 * @returns {string} Path to the logs directory
 */
function getLogsDirFromNotifyDir(notifyDir) {
  const flightpathDir = path.join(notifyDir, "..", "..");
  return path.join(flightpathDir, "logs");
}

/**
 * Derive the workspace root from a notification directory path.
 * Notification directories follow the pattern: <workspace>/.flightpath/temp/<harness>-notifications
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
 * Derives the workspace root from the notification directory (argv[2]),
 * checks whether diagnostic logging is enabled, and returns a configured
 * logger. Returns a no-op logger if diagnostics are disabled or if any
 * step fails — hook scripts must never crash due to logging setup.
 *
 * @param {string} scriptName - Base name for the log file (e.g., 'flightpath-claude-hook')
 * @param {string|undefined} notifyDir - Notification directory path (argv[2])
 * @returns {function(string, object=): void} Configured logger function
 */
function initializeLogger(scriptName, notifyDir) {
  try {
    if (notifyDir) {
      const workspaceRoot = getWorkspaceRootFromNotifyDir(notifyDir);
      // Check env var first (injected into hook command when setting is on),
      // then fall back to flag file check. Matches mcp-server.ts pattern.
      const enabled =
        process.env.FLIGHTPATH_DIAGNOSTIC_LOGS === "true" ||
        isDiagnosticLogsEnabled(workspaceRoot);
      if (enabled) {
        const logsDir = getLogsDirFromNotifyDir(notifyDir);
        return createLogger(getDebugLogPath(logsDir, scriptName));
      }
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
 * @param {string} scriptPrefix - Prefix for console.error messages (e.g., 'FlightPath Claude Hook')
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

module.exports = {
  isDiagnosticLogsEnabled,
  getDebugLogPath,
  getTempLogPath,
  createLogger,
  getLogsDirFromNotifyDir,
  getWorkspaceRootFromNotifyDir,
  initializeLogger,
  readStdinJson,
};
