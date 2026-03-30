import * as path from "path";
import {
  INotificationMonitor,
  HookConfig,
  NotificationMonitorBase,
} from "../shared/interfaces/INotificationMonitor";
import { PATH_CONSTANTS } from "../../../utils/ConfigurationUtils";
import type { UserHookConfig } from "../../../types/FlightPathTypes";

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
    userHooks?: UserHookConfig[]
  ): HookConfig {
    // Convert paths to forward slashes (works on Windows and avoids escaping issues)
    const normalizedScriptPath = scriptPath.replace(/\\/g, "/");
    const normalizedNotifyDir = notifyDir.replace(/\\/g, "/");

    const flightpathEntry = {
      hooks: [
        {
          type: "command",
          command: `node "${normalizedScriptPath}" "${normalizedNotifyDir}"`,
        },
      ],
    };

    // Map logical event names to Claude's native event names
    const eventMap: Record<string, string> = {
      stop: "Stop",
      sessionStart: "SessionStart",
      preToolUse: "PreToolUse",
      postToolUse: "PostToolUse",
    };

    // Build hooks object starting with FlightPath's entries
    const hooks: Record<string, unknown[]> = {
      SessionStart: [flightpathEntry],
      Stop: [flightpathEntry],
    };

    // Append user hooks to their respective events
    if (userHooks) {
      for (const uh of userHooks) {
        const nativeEvent = eventMap[uh.event];
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
    return path.join(
      workspaceRoot,
      PATH_CONSTANTS.FLIGHTPATH_DIR,
      PATH_CONSTANTS.TEMP_DIR,
      "claude-notifications"
    );
  }
}
