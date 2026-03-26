// FlightPath OpenCode Completion Plugin
//
// Source: src/scripts/flightpath-opencode-plugin.js
// Deployed by FlightPath to: .opencode/plugin/flightpath-completion-hook.js
//
// FlightPath injects two environment variables into the OpenCode process:
//   FLIGHTPATH_NOTIFY_DIR — absolute path to the notification directory
//   FLIGHTPATH_RUN_ID     — per-run UUID for collision-free start file naming
//
// Plugin behaviour:
//  - Tracks main sessions (no parentID) via session.created events
//  - Writes {runId}-start.json on session.created (FLIGHTPATH_RUN_ID as file name;
//    falls back to sessionId if the env var is absent for backwards compatibility)
//  - Writes {sessionId}-stop.json on session.status idle (completion detection)
//  - Filters child sessions (multi-agent subagents) to avoid false positives
//
// Diagnostic logging:
//  - Enabled when FLIGHTPATH_DIAGNOSTIC_LOGS=true is set in the process environment
//  - Logs written to .flightpath/logs/flightpath-opencode-plugin-debug.log

/* global exports, require */

const { writeFileSync, mkdirSync, appendFileSync } = require("fs");
const path = require("path");

const NOTIFY_DIR = process.env.FLIGHTPATH_NOTIFY_DIR;
const RUN_ID = process.env.FLIGHTPATH_RUN_ID || null;
const mainSessions = new Set();

// Derive the logs directory from the notification directory path.
// NOTIFY_DIR = <workspace>/.flightpath/temp/opencode-notifications — go up 2 levels.
const _logsDir = NOTIFY_DIR ? path.resolve(NOTIFY_DIR, "..", "..", "logs") : null;

let _logPath = null;
try {
  if (process.env.FLIGHTPATH_DIAGNOSTIC_LOGS === "true" && _logsDir) {
    mkdirSync(_logsDir, { recursive: true });
    _logPath = path.join(_logsDir, "flightpath-opencode-plugin-debug.log");
  }
} catch (_e) {
  // Ignore logging setup errors — plugin must never crash due to diagnostics
}

/**
 * Append a timestamped entry to the debug log file.
 * All errors are silently swallowed so hook execution is never interrupted.
 *
 * @param {string} message - Log message
 * @param {object} [data] - Optional structured data to include
 */
function _debugLog(message, data) {
  if (!_logPath) {
    return;
  }
  try {
    const timestamp = new Date().toISOString();
    let entry = `[${timestamp}] ${message}`;
    if (data !== undefined && data !== null) {
      entry += "\n" + JSON.stringify(data, null, 2);
    }
    entry += "\n---\n";
    appendFileSync(_logPath, entry);
  } catch (_writeError) {
    // Silently ignore debug logging errors
  }
}

exports.FlightPathHook = async (_hookContext) => {
  _debugLog("🚀 FlightPath OpenCode plugin loaded", {
    notifyDir: NOTIFY_DIR,
    runId: RUN_ID,
    diagnosticsEnabled: _logPath !== null,
  });

  return {
    event: async ({ event }) => {
      _debugLog("📥 Event received", { type: event.type });

      if (event.type === "session.created") {
        const session = event.properties.info;
        _debugLog("🔍 session.created", {
          sessionId: session.id,
          parentID: session.parentID ?? null,
        });
        if (!session.parentID) {
          mainSessions.add(session.id);
          try {
            mkdirSync(NOTIFY_DIR, { recursive: true });
            // Use the FlightPath run ID as the file name when available so
            // waitForSessionStart can do a direct lookup ({runId}-start.json)
            // rather than a wildcard scan — preventing parallel-workflow races.
            // Fall back to the session ID for backwards compatibility.
            const startName = RUN_ID || session.id;
            const startFile = `${NOTIFY_DIR}/${startName}-start.json`;
            writeFileSync(
              startFile,
              JSON.stringify({
                hookEvent: "SessionStart",
                sessionId: session.id,
                status: "started",
                timestamp: Date.now(),
              })
            );
            _debugLog("✅ Wrote start file", {
              file: startFile,
              runId: RUN_ID,
              sessionId: session.id,
            });
          } catch (e) {
            _debugLog("❌ Failed to write start file", { error: String(e) });
          }
        }
      }

      if (event.type === "session.deleted") {
        const deletedId = event.properties.info.id;
        mainSessions.delete(deletedId);
        _debugLog("🗑️ session.deleted", { sessionId: deletedId });
      }

      if (event.type === "session.status") {
        const { sessionID, status } = event.properties;
        _debugLog("🔄 session.status", {
          sessionID,
          statusType: status.type,
          isMainSession: mainSessions.has(sessionID),
        });
        if (status.type === "idle" && mainSessions.has(sessionID)) {
          try {
            mkdirSync(NOTIFY_DIR, { recursive: true });
            const stopFile = `${NOTIFY_DIR}/${sessionID}-stop.json`;
            writeFileSync(
              stopFile,
              JSON.stringify({
                hookEvent: "Stop",
                sessionId: sessionID,
                status: "completed",
                timestamp: Date.now(),
              })
            );
            _debugLog("✅ Wrote stop file", { file: stopFile, sessionID });
          } catch (e) {
            _debugLog("❌ Failed to write stop file", { error: String(e) });
          }
        }
      }
    },
  };
};
