// FlightPath OpenCode Completion Plugin
//
// Source: src/scripts/flightpath-opencode-plugin.ts
// Deployed by FlightPath to: .opencode/plugin/flightpath-completion-hook.ts
//
// OpenCode only loads .ts plugins (not .js). This file must remain TypeScript
// with ESM import/export syntax.
//
// FlightPath injects environment variables into the OpenCode process:
//   FLIGHTPATH_NOTIFY_DIR — absolute path to the notification directory
//   FLIGHTPATH_RUN_ID     — per-run UUID for collision-free start file naming
//
// Plugin behaviour:
//  - Writes {runId}-start.json on session.created (fallback to sessionId)
//  - Writes {sessionId}-stop.json on session.idle (completion detection)
//  - Note: session.created has a known OpenCode bug — may not fire (#14808)
//
// Diagnostic logging:
//  - Enabled when FLIGHTPATH_DIAGNOSTIC_LOGS=true
//  - Logs written to .flightpath/logs/flightpath-opencode-plugin-debug.log

import { writeFileSync, mkdirSync, appendFileSync } from "fs";
import path from "path";

const NOTIFY_DIR: string | undefined = process.env.FLIGHTPATH_NOTIFY_DIR;
const RUN_ID: string | undefined = process.env.FLIGHTPATH_RUN_ID;

const _logsDir = NOTIFY_DIR ? path.resolve(NOTIFY_DIR, "..", "..", "logs") : null;
let _logPath: string | null = null;
try {
  if (process.env.FLIGHTPATH_DIAGNOSTIC_LOGS === "true" && _logsDir) {
    mkdirSync(_logsDir, { recursive: true });
    _logPath = path.join(_logsDir, "flightpath-opencode-plugin-debug.log");
  }
} catch (_e) {}

function _debugLog(message: string, data?: unknown): void {
  if (!_logPath) return;
  try {
    const ts = new Date().toISOString();
    let entry = `[${ts}] ${message}`;
    if (data !== undefined && data !== null) entry += "\n" + JSON.stringify(data, null, 2);
    appendFileSync(_logPath, entry + "\n---\n");
  } catch (_e) {}
}

export const FlightPathHook = async (_hookContext: unknown) => {
  _debugLog("🚀 FlightPath OpenCode plugin loaded", {
    notifyDir: NOTIFY_DIR,
    runId: RUN_ID,
    diagnosticsEnabled: _logPath !== null,
  });

  return {
    event: async ({ event }: { event: { type: string; properties: Record<string, unknown> } }) => {
      _debugLog("📥 Event received", { type: event.type });

      if (event.type === "session.created") {
        const session = event.properties.info as { id: string; parentID?: string };
        _debugLog("🔍 session.created", { sessionId: session.id, parentID: session.parentID ?? null });
        if (!session.parentID && NOTIFY_DIR) {
          try {
            mkdirSync(NOTIFY_DIR, { recursive: true });
            const startName = RUN_ID || session.id;
            const startFile = `${NOTIFY_DIR}/${startName}-start.json`;
            writeFileSync(startFile, JSON.stringify({
              hookEvent: "SessionStart",
              sessionId: session.id,
              status: "started",
              timestamp: Date.now(),
            }));
            _debugLog("✅ Wrote start file", { file: startFile, runId: RUN_ID, sessionId: session.id });
          } catch (e) {
            _debugLog("❌ Failed to write start file", { error: String(e) });
          }
        }
      }

      if (event.type === "session.idle") {
        const { sessionID } = event.properties as { sessionID: string };
        _debugLog("🛑 session.idle", { sessionID });
        if (NOTIFY_DIR) {
          try {
            mkdirSync(NOTIFY_DIR, { recursive: true });
            const stopFile = `${NOTIFY_DIR}/${sessionID}-stop.json`;
            writeFileSync(stopFile, JSON.stringify({
              hookEvent: "Stop",
              sessionId: sessionID,
              status: "completed",
              timestamp: Date.now(),
            }));
            _debugLog("✅ Wrote stop file", { file: stopFile, sessionID });
          } catch (e) {
            _debugLog("❌ Failed to write stop file", { error: String(e) });
          }
        }
      }
    },
  };
};
