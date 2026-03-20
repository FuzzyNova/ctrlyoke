import {
  INotificationMonitor,
  HookConfig,
  NotificationMonitorBase,
} from "../shared/interfaces/INotificationMonitor";
import { CliNotificationMonitor } from "../shared/CliNotificationMonitor";

/**
 * Qwen Code CLI Notification Monitor
 *
 * Hook configuration: Written to .qwen/settings.json in workspace (no --settings flag).
 * Requires --experimental-hooks CLI flag to activate the hook system.
 * Notification directory: .flightpath/temp/qwen-notifications/
 * Notification script: flightpath-qwen-hook.js
 *
 * Qwen Code is a Claude fork — uses the same hook event names (SessionStart + Stop)
 * and the same two-file notification format.
 *
 * All monitoring logic (waitForSessionStart, monitorForCompletion,
 * cleanupNotificationFiles, extractSessionId) is inherited from NotificationMonitorBase.
 */
export class QwenNotificationMonitor
  extends NotificationMonitorBase
  implements INotificationMonitor
{
  /**
   * Build hook configuration for Qwen Code CLI.
   *
   * Returns a JSON object that QwenCliProvider merges into .qwen/settings.json.
   * Uses SessionStart + Stop (same event names as Claude).
   */
  buildHookConfig(
    scriptPath: string,
    notifyDir: string,
    _workspaceRoot: string
  ): HookConfig {
    const normalizedScriptPath = scriptPath.replace(/\\/g, "/");
    const normalizedNotifyDir = notifyDir.replace(/\\/g, "/");
    const command = `node "${normalizedScriptPath}" "${normalizedNotifyDir}"`;

    return {
      type: "json",
      config: {
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command }] }],
          Stop: [{ hooks: [{ type: "command", command }] }],
        },
      },
    };
  }

  /**
   * Get notification directory for Qwen Code CLI.
   * Uses shared pattern: {workspace}/.flightpath/temp/qwen-notifications/
   */
  getNotificationDirectory(workspaceRoot: string): string {
    return CliNotificationMonitor.getNotificationDirectory(
      workspaceRoot,
      "qwen"
    );
  }
}
