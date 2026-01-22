import {
  INotificationMonitor,
  NotificationConfig,
  NotificationResult,
  HookConfig,
} from "../shared/interfaces/INotificationMonitor";
import { CliNotificationMonitor } from "../shared/CliNotificationMonitor";

/**
 * Copilot CLI Notification Monitor
 *
 * Monitors for session lifecycle via hooks:
 * - sessionStart: Signals when CLI session begins (no session ID provided)
 * - sessionEnd: Signals when CLI session completes
 * - Hook file: .github/hooks/flightpath.json
 * - Hook script: flightpath-copilot-hook.js (writes notification files)
 * - Notification directory: .flightpath/notify-copilot/
 * - Detection: File-based polling for start/completion notifications
 *
 * Note: Copilot hooks do NOT provide session IDs in notifications.
 * Session IDs must be extracted from process log files separately.
 */
export class CopilotNotificationMonitor implements INotificationMonitor {
  /**
   * Copilot does NOT include session IDs in notification filenames.
   * Files are named: sessionStart-{timestamp}.json, sessionEnd-{timestamp}.json
   * This forces wildcard monitoring mode (monitor any new file).
   */
  readonly supportsSessionIdInFilename = false;
  /**
   * Monitor for completion notification
   *
   * Delegates to shared CliNotificationMonitor utility.
   * Uses wildcard mode (sessionId = undefined) since Copilot hooks don't provide session IDs.
   *
   * @param config Monitoring configuration
   * @param sessionId Optional session ID (undefined for wildcard mode)
   * @param startTime Execution start time
   * @param onCancel Cancellation callback
   * @returns Monitoring result
   */
  async monitorForCompletion(
    config: NotificationConfig,
    sessionId: string | undefined,
    startTime: Date,
    onCancel?: () => boolean
  ): Promise<NotificationResult> {
    return CliNotificationMonitor.monitorForCompletion(
      config,
      sessionId,
      startTime,
      onCancel
    );
  }

  /**
   * Build Copilot hook configuration
   *
   * Creates JSON object for .github/hooks/flightpath.json with sessionStart and sessionEnd hooks.
   * The hooks call a Node.js script that writes notification files.
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
    // Bash: Forward slashes (works on Windows and Unix)
    const bashScriptPath = scriptPath.replace(/\\/g, "/");
    const bashNotifyDir = notifyDir.replace(/\\/g, "/");

    // PowerShell: Backslashes escaped for JSON (Windows standard)
    const psScriptPath = scriptPath.replace(/\\/g, "\\\\");
    const psNotifyDir = notifyDir.replace(/\\/g, "\\\\");

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

  /**
   * Extract session ID from notification data
   *
   * KNOWN LIMITATION: Copilot sessionEnd hooks currently do NOT provide session IDs
   * in notifications. This is a known issue we're waiting for Copilot to address.
   *
   * For now, session IDs must be extracted from log files via
   * CopilotCliProvider.extractSessionIdFromLogs().
   *
   * This method is kept for future compatibility when Copilot adds session ID support
   * to their hook notifications.
   *
   * @param data Notification file content
   * @returns Always undefined (session IDs not in Copilot notifications YET)
   */
  extractSessionId?(data: any): string | undefined {
    // Copilot hooks don't include session IDs in notifications (yet)
    return undefined;
  }

  /**
   * Wait for SessionStart hook notification
   *
   * Monitors for sessionStart hook notification to confirm CLI session has started.
   * Copilot's sessionStart hook does NOT provide session IDs.
   * This method is used to wait until Copilot CLI is ready before discovering log files.
   *
   * Uses wildcard monitoring since Copilot hooks don't provide session IDs.
   * Hook writes: sessionStart-{timestamp}.json
   *
   * @param config Monitoring configuration
   * @param startTime Execution start time
   * @param onCancel Cancellation callback
   * @returns NotificationResult (completed=true on success, sessionId not provided)
   */
  async waitForSessionStart(
    config: NotificationConfig,
    startTime: Date,
    onCancel?: () => boolean
  ): Promise<NotificationResult> {
    // Monitor for any sessionStart notification file (wildcard mode)
    // Copilot hooks don't provide session IDs, but we still get confirmation
    return await CliNotificationMonitor.monitorForCompletion(
      config,
      undefined, // sessionId undefined = wildcard mode
      startTime,
      onCancel
    );
  }
}
