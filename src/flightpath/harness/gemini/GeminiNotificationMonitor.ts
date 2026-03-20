import * as path from "path";
import {
  INotificationMonitor,
  HookConfig,
  NotificationMonitorBase,
} from "../shared/interfaces/INotificationMonitor";
import { PATH_CONSTANTS } from "../../../utils/ConfigurationUtils";

/**
 * Gemini CLI Notification Monitor
 *
 * Hook configuration: Written to .gemini/settings.json in workspace (no --settings flag).
 * Notification directory: .flightpath/temp/gemini-notifications/
 * Notification script: flightpath-gemini-hook.js
 *
 * Gemini uses AfterAgent (not Stop) as the completion event.
 * The hook script normalizes AfterAgent → hookEvent: "Stop" so
 * NotificationMonitorBase.monitorForCompletion() works unchanged.
 *
 * All monitoring logic (waitForSessionStart, monitorForCompletion,
 * cleanupNotificationFiles, extractSessionId) is inherited from NotificationMonitorBase.
 */
export class GeminiNotificationMonitor
  extends NotificationMonitorBase
  implements INotificationMonitor
{
  /**
   * Build hook configuration for Gemini CLI.
   *
   * Returns a JSON object that GeminiCliProvider merges into .gemini/settings.json.
   * Uses SessionStart + AfterAgent (Gemini's completion event).
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
          AfterAgent: [{ hooks: [{ type: "command", command }] }],
        },
      },
    };
  }

  getNotificationDirectory(workspaceRoot: string): string {
    return path.join(
      workspaceRoot,
      PATH_CONSTANTS.FLIGHTPATH_DIR,
      PATH_CONSTANTS.TEMP_DIR,
      "gemini-notifications"
    );
  }
}
