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

module.exports = {
  getDebugLogPath,
  getTempLogPath,
  createLogger,
  getLogsDirFromNotifyDir,
};
