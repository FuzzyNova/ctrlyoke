import {
  INotificationMonitor,
  HookConfig,
  NotificationMonitorBase,
} from "../shared/interfaces/INotificationMonitor";
import { CliNotificationMonitor } from "../shared/CliNotificationMonitor";
import type { HookEvent, UserHookConfig } from "../../../types/CtrlYokeTypes";

/**
 * Copilot CLI Notification Monitor
 *
 * Hook file format: .github/hooks/ctrlyoke.json (bash/powershell fields)
 * Notification directory: .ctrlyoke/temp/copilot-notifications/
 * Notification script: ctrlyoke-copilot-hook.js
 *
 * Notification file format (standardized with Claude):
 *   {sessionId}-start.json → { hookEvent: "SessionStart", sessionId, status: "started" }
 *   {sessionId}-stop.json  → { hookEvent: "Stop", sessionId, status: "completed" }
 *
 * All monitoring logic (waitForSessionStart, monitorForCompletion,
 * cleanupNotificationFiles, extractSessionId) is inherited from NotificationMonitorBase.
 */
export class CopilotNotificationMonitor
  extends NotificationMonitorBase
  implements INotificationMonitor
{
  /** Logical → Copilot native event name mapping. Shared with CopilotChatIntegration. */
  static readonly EVENT_MAP: Record<string, string> = {
    stop: "agentStop",
    error: "errorOccurred",
    sessionStart: "sessionStart",
    preToolUse: "preToolUse",
    postToolUse: "postToolUse",
    userPromptSubmit: "userPromptSubmitted",
    permissionRequest: "permissionRequest",
  };

  /**
   * Build a user-hooks-only Copilot hook config object (no ctrlyoke notification entries).
   * Used by CopilotChatIntegration, which has its own completion detection mechanism.
   */
  static buildUserOnlyConfig(
    userHooks: UserHookConfig[]
  ): Record<string, unknown> {
    const hooks: Record<string, unknown[]> = {};
    for (const uh of userHooks) {
      const nativeEvent = CopilotNotificationMonitor.EVENT_MAP[uh.event];
      if (!nativeEvent) continue;
      if (!hooks[nativeEvent]) hooks[nativeEvent] = [];
      hooks[nativeEvent].push({
        type: "command",
        bash: uh.command,
        powershell: uh.command,
        timeoutSec: uh.timeoutSec ?? 10,
      });
    }
    return { version: 1, hooks };
  }

  /**
   * Build Copilot hook configuration
   *
   * Creates JSON object for .github/hooks/ctrlyoke.json with sessionStart and sessionEnd hooks.
   * The hooks call a Node.js script that writes notification files in the standardized format.
   *
   * @param scriptPath Path to notification handler script (ctrlyoke-copilot-hook.js)
   * @param notifyDir Notification directory path
   * @param workspaceRoot Workspace root directory (unused for Copilot)
   * @returns Hook configuration as JSON object
   */
  buildHookConfig(
    scriptPath: string,
    notifyDir: string,
    _workspaceRoot: string,
    userHooks?: UserHookConfig[],
    ctrlyokeEvents?: HookEvent[]
  ): HookConfig {
    // Normalize Windows drive letter to lowercase for stable output (VS Code returns
    // uppercase from GUI launches, lowercase from CLI launches — normalize to avoid
    // spurious diffs in the tracked .github/hooks/ctrlyoke.json file).
    const normalizeDrive = (p: string) =>
      p.replace(/^([A-Za-z]):/, (_, d) => d.toLowerCase() + ":");
    const normalizedScriptPath = normalizeDrive(scriptPath);
    const normalizedNotifyDir = normalizeDrive(notifyDir);

    // Bash: Forward slashes (works on Windows and Unix)
    const bashScriptPath = normalizedScriptPath.replace(/\\/g, "/");
    const bashNotifyDir = normalizedNotifyDir.replace(/\\/g, "/");

    // PowerShell: Backslashes escaped for JSON (Windows standard)
    const psScriptPath = normalizedScriptPath.replace(/\\/g, "\\\\");
    const psNotifyDir = normalizedNotifyDir.replace(/\\/g, "\\\\");

    // Map logical event names to Copilot's native event names
    const eventMap = CopilotNotificationMonitor.EVENT_MAP;
    const selectedEvents = ctrlyokeEvents ?? [
      "sessionStart",
      "stop",
      "error",
    ];
    const permissionRequestHook = userHooks?.find(
      (hook) => hook.event === "permissionRequest"
    );
    const encodedDecisionHook = permissionRequestHook
      ? Buffer.from(permissionRequestHook.command, "utf8").toString("base64")
      : undefined;

    const hooks: Record<string, unknown[]> = {};

    for (const event of selectedEvents) {
      const nativeEvent = eventMap[event];
      if (!nativeEvent) {
        continue;
      }
      const bashCommand =
        event === "permissionRequest" && encodedDecisionHook
          ? `node "${bashScriptPath}" "${bashNotifyDir}" "${nativeEvent}" "${encodedDecisionHook}"`
          : `node "${bashScriptPath}" "${bashNotifyDir}" "${nativeEvent}"`;
      const powershellCommand =
        event === "permissionRequest" && encodedDecisionHook
          ? `node "${psScriptPath}" "${psNotifyDir}" "${nativeEvent}" "${encodedDecisionHook}"`
          : `node "${psScriptPath}" "${psNotifyDir}" "${nativeEvent}"`;
      hooks[nativeEvent] = [
        {
          type: "command",
          bash: bashCommand,
          powershell: powershellCommand,
          timeoutSec: 10,
        },
      ];
    }

    // Append user hooks
    if (userHooks) {
      for (const uh of userHooks) {
        if (
          uh.event === "permissionRequest" &&
          selectedEvents.includes("permissionRequest")
        ) {
          continue;
        }
        const nativeEvent = eventMap[uh.event];
        if (!nativeEvent) continue;
        if (!hooks[nativeEvent]) hooks[nativeEvent] = [];
        hooks[nativeEvent].push({
          type: "command",
          bash: uh.command,
          powershell: uh.command,
          timeoutSec: uh.timeoutSec ?? 10,
        });
      }
    }

    return {
      type: "json",
      config: { version: 1, hooks },
    };
  }

  /**
   * Get notification directory for Copilot CLI
   *
   * Uses shared pattern: {workspace}/.ctrlyoke/temp/copilot-notifications/
   *
   * @param workspaceRoot Workspace root directory
   * @returns Notification directory path
   */
  getNotificationDirectory(workspaceRoot: string): string {
    return CliNotificationMonitor.getNotificationDirectory(
      workspaceRoot,
      "copilot"
    );
  }
}
