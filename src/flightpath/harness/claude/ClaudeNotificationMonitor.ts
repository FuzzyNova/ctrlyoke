import {
  INotificationMonitor,
  HookConfig,
  NotificationMonitorBase,
} from "../shared/interfaces/INotificationMonitor";
import { CliNotificationMonitor } from "../shared/CliNotificationMonitor";
import type { HookEvent, UserHookConfig } from "../../../types/FlightPathTypes";

/**
 * Claude CLI Notification Monitor
 *
 * Hook configuration: JSON string passed via --settings flag
 * Notification directory: .flightpath/temp/claude-notifications/
 * Notification script: flightpath-claude-hook.js
 *
 * Notification file format (standardized with Copilot):
 *   {sessionId}-start.json → { hookEvent: "SessionStart", sessionId, status: "started" }
 *   {sessionId}-stop.json  → { hookEvent: "Stop", sessionId, status: "completed" }
 *
 * All monitoring logic (waitForSessionStart, monitorForCompletion,
 * cleanupNotificationFiles, extractSessionId) is inherited from NotificationMonitorBase.
 */
export class ClaudeNotificationMonitor
  extends NotificationMonitorBase
  implements INotificationMonitor
{
  /** Map logical event names to Claude's native event names. */
  static readonly EVENT_MAP: Record<string, string> = {
    stop: "Stop",
    sessionStart: "SessionStart",
    preToolUse: "PreToolUse",
    postToolUse: "PostToolUse",
    userPromptSubmit: "UserPromptSubmit",
    // Decision hook: Claude pipes the payload on stdin and reads stdout as the
    // allow/deny decision. Registered as a direct hook entry — not via the
    // FlightPath notification script — so Claude handles the stdin/stdout
    // contract natively without FlightPath interception.
    permissionRequest: "PermissionRequest",
  };

  /**
   * Build a user-hooks-only Claude settings JSON string (no FlightPath notification entries).
   * Used for headless mode where completion detection is process-exit based.
   */
  static buildUserOnlyConfig(userHooks: UserHookConfig[]): string {
    const hooks: Record<string, unknown[]> = {};
    for (const uh of userHooks) {
      const nativeEvent = ClaudeNotificationMonitor.EVENT_MAP[uh.event];
      if (!nativeEvent) continue;
      if (!hooks[nativeEvent]) hooks[nativeEvent] = [];
      hooks[nativeEvent].push({
        hooks: [{ type: "command", command: uh.command }],
      });
    }
    return JSON.stringify({ hooks });
  }

  /**
   * Build hook configuration for Claude CLI
   *
   * Claude uses JSON string (not object) for --settings flag.
   * Configures both SessionStart and Stop hooks.
   *
   * @param scriptPath Path to notification handler script (flightpath-claude-hook.js)
   * @param notifyDir Notification directory
   * @param workspaceRoot Workspace root directory (unused for Claude)
   * @returns Hook configuration as JSON string
   */
  buildHookConfig(
    scriptPath: string,
    notifyDir: string,
    _workspaceRoot: string,
    userHooks?: UserHookConfig[],
    flightpathEvents?: HookEvent[]
  ): HookConfig {
    const command = CliNotificationMonitor.buildNodeCommand(
      scriptPath,
      notifyDir
    );
    const selectedEvents = flightpathEvents ?? ["sessionStart", "stop"];
    const permissionRequestHook = userHooks?.find(
      (hook) => hook.event === "permissionRequest"
    );
    const encodedDecisionHook = permissionRequestHook
      ? Buffer.from(permissionRequestHook.command, "utf8").toString("base64")
      : undefined;

    const hooks: Record<string, unknown[]> = {};
    for (const event of selectedEvents) {
      const nativeEvent = ClaudeNotificationMonitor.EVENT_MAP[event];
      if (!nativeEvent) {
        continue;
      }
      const eventCommand =
        event === "permissionRequest" && encodedDecisionHook
          ? `${command} "${encodedDecisionHook}"`
          : command;
      hooks[nativeEvent] = [
        {
          hooks: [{ type: "command", command: eventCommand }],
        },
      ];
    }

    // Append user hooks to their respective events
    if (userHooks) {
      for (const uh of userHooks) {
        if (
          uh.event === "permissionRequest" &&
          selectedEvents.includes("permissionRequest")
        ) {
          continue;
        }
        const nativeEvent = ClaudeNotificationMonitor.EVENT_MAP[uh.event];
        if (!nativeEvent) continue; // Skip unsupported events
        if (!hooks[nativeEvent]) hooks[nativeEvent] = [];
        hooks[nativeEvent].push({
          hooks: [{ type: "command", command: uh.command }],
        });
      }
    }

    return {
      type: "json-string",
      config: JSON.stringify({ hooks }),
    };
  }

  /**
   * Get notification directory for Claude CLI
   *
   * @param workspaceRoot Workspace root
   * @returns Notification directory path
   */
  getNotificationDirectory(workspaceRoot: string): string {
    return CliNotificationMonitor.getNotificationDirectory(
      workspaceRoot,
      "claude"
    );
  }
}
