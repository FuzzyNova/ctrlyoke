// ctrlyoke OpenCode Completion Plugin
//
// Source: src/scripts/ctrlyoke-opencode-plugin.ts
// Deployed by ctrlyoke to: .opencode/plugin/ctrlyoke-completion-hook.ts
//
// OpenCode only loads .ts plugins (not .js). This file must remain TypeScript
// with ESM import/export syntax.
//
// ctrlyoke injects environment variables into the OpenCode process:
//   CTRLYOKE_NOTIFY_DIR      — absolute path to the notification directory
//   CTRLYOKE_RUN_ID          — per-run UUID for collision-free start file naming
//   CTRLYOKE_WORKSPACE_ROOT  — workspace root directory
//
// User hooks are loaded at startup from a JSON sidecar file written alongside
// this plugin by ctrlyoke's deployCompletionPlugin():
//   {workspaceRoot}/.opencode/plugin/ctrlyoke-hooks.json
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
//  - Enabled when CTRLYOKE_DIAGNOSTIC_LOGS=true
//  - Logs written to .ctrlyoke/logs/ctrlyoke-opencode-plugin-debug.log

import { writeFileSync, readFileSync, mkdirSync, appendFileSync } from "fs";
import { execSync, spawnSync } from "child_process";
import path from "path";

const NOTIFY_DIR: string | undefined = process.env.CTRLYOKE_NOTIFY_DIR;
const RUN_ID: string | undefined = process.env.CTRLYOKE_RUN_ID;
const workspaceRoot: string =
  process.env.CTRLYOKE_WORKSPACE_ROOT || process.cwd();
const ENABLED_HOOK_EVENTS = new Set(
  (process.env.CTRLYOKE_NOTIFY_HOOK_EVENTS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
);

interface HookArtifact {
  runId: string;
  timestamp: number;
  workflowId: string;
  workflowName: string;
  promptIndex: number;
  promptName: string;
  hookEvent: string;
  nativeHookEvent: string;
  harnessId: string;
  sessionId?: string;
  toolName?: string;
  rawHookData: unknown;
}

// Track CHILD sessions (sub-agents) to avoid treating them as completion events.
// Child sessions have a parentID and are created DURING execution, so their
// session.created events reach the plugin reliably (unlike the main session).
const childSessions = new Set<string>();

// Track main sessions for start file deduplication.
const mainSessions = new Set<string>();

// Track which sessions have had their start file written.
const startFilesWritten = new Set<string>();
let hookArtifactCounter = 0;

// Load user hooks from the sidecar JSON file written by ctrlyoke alongside this plugin.
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
    "ctrlyoke-hooks.json"
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

/**
 * Run the first user hook matching `event`, pipe `payloadJson` on stdin,
 * capture stdout, and return the parsed decision object. Returns undefined
 * when no hook is configured or the hook produces no output.
 *
 * Used for decision hooks (permissionRequest) where the hook script's stdout
 * is the harness decision rather than a fire-and-forget side-effect.
 */
function _runDecisionUserHook(
  event: string,
  payloadJson: string
): unknown | undefined {
  for (const hook of _userHooks) {
    if (hook.event === event) {
      try {
        const result = spawnSync(hook.command, {
          input: payloadJson,
          encoding: "utf-8",
          shell: true,
          cwd: workspaceRoot,
        });
        _debugLog("🔐 _runDecisionUserHook: ran", {
          event,
          command: hook.command,
          exitCode: result.status,
          stdout: result.stdout,
        });
        if (result.stdout && result.stdout.trim()) {
          try {
            return JSON.parse(result.stdout.trim());
          } catch (_parseErr) {
            // Hook produced non-JSON stdout — ignore, let OpenCode decide natively
            _debugLog("⚠️ _runDecisionUserHook: non-JSON stdout ignored", {
              stdout: result.stdout,
            });
          }
        }
      } catch (_e) {
        _debugLog("❌ _runDecisionUserHook: error", { error: String(_e) });
      }
      // Only run the first matching hook per event
      break;
    }
  }
  return undefined;
}

// Diagnostic logging — derive logs dir from NOTIFY_DIR (interactive) or workspaceRoot (headless).
const _logsDir = NOTIFY_DIR
  ? path.resolve(NOTIFY_DIR, "..", "..", "logs")
  : path.join(workspaceRoot, ".ctrlyoke", "logs");
let _logPath: string | null = null;
try {
  if (process.env.CTRLYOKE_DIAGNOSTIC_LOGS === "true" && _logsDir) {
    mkdirSync(_logsDir, { recursive: true });
    _logPath = path.join(_logsDir, "ctrlyoke-opencode-plugin-debug.log");
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

export const CtrlYokeHook = async (_hookContext: unknown) => {
  _debugLog("🚀 ctrlyoke OpenCode plugin loaded", {
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

  function _resolveSessionId(properties: Record<string, unknown>): string | null {
    const directSessionId =
      typeof properties.sessionID === "string"
        ? properties.sessionID
        : typeof properties.sessionId === "string"
          ? properties.sessionId
          : typeof properties.session_id === "string"
            ? properties.session_id
            : null;

    if (directSessionId) {
      return directSessionId;
    }

    const info = properties.info as
      | { id?: unknown; sessionID?: unknown; sessionId?: unknown }
      | undefined;
    if (typeof info?.id === "string") {
      return info.id;
    }
    if (typeof info?.sessionID === "string") {
      return info.sessionID;
    }
    if (typeof info?.sessionId === "string") {
      return info.sessionId;
    }

    return null;
  }

  function _buildHookArtifactBase(): Omit<
    HookArtifact,
    "hookEvent" | "nativeHookEvent" | "rawHookData"
  > | null {
    if (!NOTIFY_DIR || !RUN_ID) {
      return null;
    }
    return {
      runId: RUN_ID,
      timestamp: Date.now(),
      workflowId: process.env.CTRLYOKE_WORKFLOW_ID || "",
      workflowName: process.env.CTRLYOKE_WORKFLOW_NAME || "",
      promptIndex: parseInt(process.env.CTRLYOKE_PROMPT_INDEX || "0", 10),
      promptName: process.env.CTRLYOKE_PROMPT_NAME || "",
      harnessId: process.env.CTRLYOKE_HARNESS_ID || "",
    };
  }

  function _writeHookArtifact(
    hookEvent: string,
    nativeHookEvent: string,
    rawHookData: unknown,
    extras: {
      sessionId?: string;
      toolName?: string;
    } = {}
  ): void {
    if (!ENABLED_HOOK_EVENTS.has(hookEvent) || !NOTIFY_DIR) {
      return;
    }

    const base = _buildHookArtifactBase();
    if (!base) {
      return;
    }

    try {
      mkdirSync(NOTIFY_DIR, { recursive: true });
      const artifact: HookArtifact = {
        ...base,
        hookEvent,
        nativeHookEvent,
        sessionId: extras.sessionId,
        toolName: extras.toolName,
        rawHookData,
      };
      const filePath = path.join(
        NOTIFY_DIR,
        `${artifact.runId}-hook-${artifact.timestamp}-${process.pid}-${hookArtifactCounter++}.json`
      );
      writeFileSync(filePath, JSON.stringify(artifact));
      _debugLog("📤 Wrote hook artifact", {
        hookEvent,
        nativeHookEvent,
        filePath,
      });
    } catch (error) {
      _debugLog("❌ Failed to write hook artifact", { error: String(error) });
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
          _writeHookArtifact("sessionStart", "session.created", session, {
            sessionId: session.id,
          });
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
          _writeHookArtifact("sessionStart", "session.updated", session, {
            sessionId: session.id,
          });
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
            _writeHookArtifact(
              "userPromptSubmit",
              "session.status busy",
              event.properties,
              { sessionId: sessionID }
            );
            _runUserHooks("userPromptSubmit");
          } else if (status.type === "idle") {
            _debugLog("🛑 session.status idle (main)", { sessionID });
            _writeHookArtifact(
              "stop",
              "session.status idle",
              event.properties,
              {
                sessionId: sessionID,
              }
            );
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

      if (event.type === "session.error") {
        const sessionId = _resolveSessionId(event.properties);
        _debugLog("❌ session.error", {
          sessionId,
          properties: event.properties,
        });

        if (!sessionId) {
          _debugLog("⚠️ session.error missing session identifier", {
            properties: event.properties,
          });
          return;
        }

        _writeHookArtifact("error", "session.error", event.properties, {
          sessionId,
        });

        if (NOTIFY_DIR) {
          try {
            mkdirSync(NOTIFY_DIR, { recursive: true });
            const errorFile = `${NOTIFY_DIR}/${sessionId}-error.json`;
            writeFileSync(
              errorFile,
              JSON.stringify({
                hookEvent: "session.error",
                sessionId,
                status: "error",
                timestamp: Date.now(),
                rawHookData: event.properties,
              })
            );
            _debugLog("✅ Wrote error file", { file: errorFile, sessionId });
          } catch (e) {
            _debugLog("❌ Failed to write error file", {
              error: String(e),
            });
          }
        }

        _runUserHooks("error");
      }
    },

    // permission.asked is an OpenCode trigger hook — called directly by the
    // runtime (not via the event bus). Return a decision object from the user
    // hook's stdout, or undefined to let OpenCode show the dialog normally.
    // NOTE: The exact response contract (field names, envelope shape) should be
    // verified against @opencode-ai/plugin SDK types before relying on this in
    // production. The implementation below follows the same pattern as Claude's
    // PermissionRequest hook (hookSpecificOutput.decision.behavior).
    "permission.asked": async (_input: unknown) => {
      _debugLog("🔐 permission.asked", { input: _input });
      _writeHookArtifact("permissionRequest", "permission.asked", _input);
      const decision = _runDecisionUserHook(
        "permissionRequest",
        JSON.stringify(_input)
      );
      if (decision !== undefined) {
        _debugLog("🔐 permission.asked: returning user decision", { decision });
        return decision;
      }
      // No user hook or empty output — let OpenCode handle natively
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
      _writeHookArtifact("preToolUse", "tool.execute.before", _input, {
        sessionId: _input.sessionID,
        toolName: _input.tool,
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
      _writeHookArtifact("postToolUse", "tool.execute.after", _input, {
        sessionId: _input.sessionID,
        toolName: _input.tool,
      });
      _runUserHooks("postToolUse");
    },
  };
};
