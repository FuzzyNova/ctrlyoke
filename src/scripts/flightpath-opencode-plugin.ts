// FlightPath OpenCode Completion Plugin
//
// Source: src/scripts/flightpath-opencode-plugin.ts
// Deployed by FlightPath to: .opencode/plugin/flightpath-completion-hook.ts
//
// OpenCode only loads .ts plugins (not .js). This file must remain TypeScript
// with ESM import/export syntax.
//
// FlightPath injects environment variables into the OpenCode process:
//   FLIGHTPATH_NOTIFY_DIR      — absolute path to the notification directory
//   FLIGHTPATH_RUN_ID          — per-run UUID for collision-free start file naming
//   FLIGHTPATH_WORKSPACE_ROOT  — workspace root directory
//
// User hooks are loaded at startup from a JSON sidecar file written alongside
// this plugin by FlightPath's deployCompletionPlugin():
//   {workspaceRoot}/.opencode/plugin/flightpath-hooks.json
//   Format: [{ "event": "stop"|"sessionStart"|..., "command": "node ..." }, ...]
//
// Plugin behaviour:
//  - Tracks CHILD sessions (with parentID) via session.created to avoid false stops
//  - On session.status idle: fires stop hooks for any session NOT known to be a child
//  - On session.status busy: fires userPromptSubmit hooks for non-child sessions
//  - Writes {runId}-start.json on session.created / session.updated for main sessions
//  - Writes {sessionId}-stop.json on session.status idle for completion detection
//  - tool.execute.before/after handled as trigger hooks (not via event callback)
//
// Session tracking rationale:
//  - OpenCode bug #14808: session.created may not fire to the plugin for the MAIN session
//    because the event is published before the plugin's event subscription is active.
//  - Child (sub-agent) sessions are created DURING execution, so their session.created
//    events reliably reach the plugin. We track these as childSessions.
//  - By checking "NOT in childSessions" instead of "in mainSessions", we correctly
//    identify the main session even when session.created misses.
//  - session.updated is also used as a fallback to capture the main session id for
//    start file writing.
//
// Diagnostic logging:
//  - Enabled when FLIGHTPATH_DIAGNOSTIC_LOGS=true
//  - Logs written to .flightpath/logs/flightpath-opencode-plugin-debug.log

import { writeFileSync, readFileSync, mkdirSync, appendFileSync } from "fs";
import { execSync } from "child_process";
import path from "path";

const NOTIFY_DIR: string | undefined = process.env.FLIGHTPATH_NOTIFY_DIR;
const RUN_ID: string | undefined = process.env.FLIGHTPATH_RUN_ID;
const workspaceRoot: string =
  process.env.FLIGHTPATH_WORKSPACE_ROOT || process.cwd();

// Track CHILD sessions (sub-agents) to avoid treating them as completion events.
// Child sessions have a parentID and are created DURING execution, so their
// session.created events reach the plugin reliably (unlike the main session).
const childSessions = new Set<string>();

// Track main sessions for start file deduplication.
const mainSessions = new Set<string>();

// Track which sessions have had their start file written.
const startFilesWritten = new Set<string>();

// Load user hooks from the sidecar JSON file written by FlightPath alongside this plugin.
// Format: [{ event: "stop"|"sessionStart"|"preToolUse"|"postToolUse"|"userPromptSubmit", command: string }]
interface UserHook {
  event: string;
  command: string;
}
let _userHooks: UserHook[] = [];
try {
  const hooksPath = path.join(
    workspaceRoot,
    ".opencode",
    "plugin",
    "flightpath-hooks.json"
  );
  _userHooks = JSON.parse(readFileSync(hooksPath, "utf-8")) as UserHook[];
} catch {
  /* no sidecar = no user hooks, safe to ignore */
}

function _runUserHooks(event: string): void {
  for (const hook of _userHooks) {
    if (hook.event === event) {
      try {
        execSync(hook.command, { stdio: "inherit", cwd: workspaceRoot });
      } catch (_e) {}
    }
  }
}

// Diagnostic logging — derive logs dir from NOTIFY_DIR (interactive) or workspaceRoot (headless).
const _logsDir = NOTIFY_DIR
  ? path.resolve(NOTIFY_DIR, "..", "..", "logs")
  : path.join(workspaceRoot, ".flightpath", "logs");
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
    if (data !== undefined && data !== null)
      entry += "\n" + JSON.stringify(data, null, 2);
    appendFileSync(_logPath, entry + "\n---\n");
  } catch (_e) {}
}

export const FlightPathHook = async (_hookContext: unknown) => {
  _debugLog("🚀 FlightPath OpenCode plugin loaded", {
    notifyDir: NOTIFY_DIR,
    runId: RUN_ID,
    workspaceRoot,
    userHookCount: _userHooks.length,
    diagnosticsEnabled: _logPath !== null,
  });

  /**
   * Write the start notification file for a main session (once per session).
   * Called from both session.created and session.updated handlers so that
   * the file is written even when session.created misses due to OpenCode bug #14808.
   */
  function _writeStartFile(sessionId: string): void {
    if (!NOTIFY_DIR || startFilesWritten.has(sessionId)) return;
    startFilesWritten.add(sessionId);
    try {
      mkdirSync(NOTIFY_DIR, { recursive: true });
      const startName = RUN_ID || sessionId;
      const startFile = `${NOTIFY_DIR}/${startName}-start.json`;
      writeFileSync(
        startFile,
        JSON.stringify({
          hookEvent: "SessionStart",
          sessionId,
          status: "started",
          timestamp: Date.now(),
        })
      );
      _debugLog("✅ Wrote start file", {
        file: startFile,
        runId: RUN_ID,
        sessionId,
      });
    } catch (e) {
      _debugLog("❌ Failed to write start file", { error: String(e) });
    }
  }

  return {
    event: async ({
      event,
    }: {
      event: { type: string; properties: Record<string, unknown> };
    }) => {
      _debugLog("📥 Event received", { type: event.type });

      if (event.type === "session.created") {
        const session = event.properties.info as {
          id: string;
          parentID?: string;
        };
        _debugLog("🔍 session.created", {
          sessionId: session.id,
          parentID: session.parentID ?? null,
        });
        if (session.parentID) {
          // Track child (sub-agent) sessions so we can ignore their idle events.
          childSessions.add(session.id);
          _debugLog("👶 Tracking child session", { sessionId: session.id });
        } else {
          // Main session — track it and write start file.
          mainSessions.add(session.id);
          _writeStartFile(session.id);
          _runUserHooks("sessionStart");
        }
      }

      // session.updated fires reliably during execution (e.g., when title is generated).
      // Use it as a fallback to capture the main session when session.created was missed
      // due to the plugin subscription race condition (OpenCode bug #14808).
      if (event.type === "session.updated") {
        const session = event.properties.info as {
          id: string;
          parentID?: string;
        };
        if (!session.parentID && !mainSessions.has(session.id)) {
          mainSessions.add(session.id);
          _debugLog("🔄 session.updated — captured main session (fallback)", {
            sessionId: session.id,
          });
          _writeStartFile(session.id);
          // Do NOT fire sessionStart user hook here — it may have already fired
          // via session.created, and we don't want to fire it twice.
        }
      }

      if (event.type === "session.deleted") {
        const deletedId = (event.properties.info as { id: string }).id;
        mainSessions.delete(deletedId);
        childSessions.delete(deletedId);
        _debugLog("🗑️ session.deleted", { sessionId: deletedId });
      }

      if (event.type === "session.status") {
        const { sessionID, status } = event.properties as {
          sessionID: string;
          status: { type: string };
        };
        // Treat any non-child session as the main session.
        // This is intentional: session.created for the MAIN session may not reach the
        // plugin due to a startup timing race (bug #14808), so we cannot rely on
        // mainSessions.has(). Child sessions are created during execution and their
        // session.created events DO reach the plugin reliably.
        const isChildSession = childSessions.has(sessionID);
        _debugLog("🔄 session.status", {
          sessionID,
          statusType: status.type,
          isChild: isChildSession,
        });

        if (!isChildSession) {
          if (status.type === "busy") {
            _debugLog("⏩ session.status busy (main)", { sessionID });
            _runUserHooks("userPromptSubmit");
          } else if (status.type === "idle") {
            _debugLog("🛑 session.status idle (main)", { sessionID });
            if (NOTIFY_DIR) {
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
                _debugLog("❌ Failed to write stop file", {
                  error: String(e),
                });
              }
            }
            _runUserHooks("stop");
          }
        }
      }
    },

    // tool.execute.before and tool.execute.after are OpenCode trigger hooks —
    // they are called directly by the OpenCode runtime (not via the event bus).
    // They must be returned as top-level keys on the hooks object, NOT handled
    // inside the event callback (which would never receive them).
    "tool.execute.before": async (
      _input: { tool: string; sessionID: string; callID: string },
      _output: { args: unknown }
    ) => {
      _debugLog("🔧 tool.execute.before", {
        tool: _input.tool,
        sessionID: _input.sessionID,
      });
      _runUserHooks("preToolUse");
    },

    "tool.execute.after": async (
      _input: {
        tool: string;
        sessionID: string;
        callID: string;
        args: unknown;
      },
      _output: { title: string; output: string; metadata: unknown }
    ) => {
      _debugLog("✅ tool.execute.after", {
        tool: _input.tool,
        sessionID: _input.sessionID,
      });
      _runUserHooks("postToolUse");
    },
  };
};
