import * as path from "path";
import {
  INotificationMonitor,
  HookConfig,
  NotificationMonitorBase,
} from "../shared/interfaces/INotificationMonitor";
import { CliNotificationMonitor } from "../shared/CliNotificationMonitor";

/**
 * Copilot CLI Notification Monitor
 *
 * Hook file format: .github/hooks/flightpath.json (bash/powershell fields)
 * Notification directory: .flightpath/temp/copilot-notifications/
 * Notification script: flightpath-copilot-hook.js
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
  /**
   * Build Copilot hook configuration
   *
   * Creates JSON object for .github/hooks/flightpath.json with sessionStart and sessionEnd hooks.
   * The hooks call a Node.js script that writes notification files in the standardized format.
   *
   * @param scriptPath Path to notification handler script (flightpath-copilot-hook.js)
   * @param notifyDir Notification directory path
   * @param workspaceRoot Workspace root directory (unused for Copilot)
   * @returns Hook configuration as JSON object
   */
  buildHookConfig(
    scriptPath: string,
    notifyDir: string,
    workspaceRoot: string
  ): HookConfig {
    // Normalize Windows drive letter to lowercase for stable output (VS Code returns
    // uppercase from GUI launches, lowercase from CLI launches — normalize to avoid
    // spurious diffs in the tracked .github/hooks/flightpath.json file).
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

    return {
      type: "json",
      config: {
        version: 1,
        hooks: {
          sessionStart: [
            {
              type: "command",
              bash: `node "${bashScriptPath}" "${bashNotifyDir}" "sessionStart"`,
              powershell: `node "${psScriptPath}" "${psNotifyDir}" "sessionStart"`,
              timeoutSec: 10,
            },
          ],
          sessionEnd: [
            {
              type: "command",
              bash: `node "${bashScriptPath}" "${bashNotifyDir}" "sessionEnd"`,
              powershell: `node "${psScriptPath}" "${psNotifyDir}" "sessionEnd"`,
              timeoutSec: 10,
            },
          ],
        },
      },
    };
  }

  /**
   * Get notification directory for Copilot CLI
   *
   * Uses shared pattern: {workspace}/.flightpath/temp/copilot-notifications/
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
