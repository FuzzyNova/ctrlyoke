import * as path from "path";
import {
  INotificationMonitor,
  NotificationConfig,
  NotificationResult,
  HookConfig,
  NotificationMonitorBase,
} from "../shared/interfaces/INotificationMonitor";
import { CliNotificationMonitor } from "../shared/CliNotificationMonitor";
import { Log } from "../../../utils/Log";

/**
 * Claude CLI Notification Monitor
 *
 * Monitors for completion via Claude CLI Stop hooks:
 * - Stop hook writes notification file when execution completes
 * - Notification file contains session ID and timestamp
 * - Supports wildcard mode (sessionId = undefined) for first file detection
 * - Settings format: JSON string (not object) for --settings flag
 *
 * Hook configuration:
 * {
 *   "hooks": {
 *     "Stop": [{
 *       "hooks": [{
 *         "type": "command",
 *         "command": "node /path/to/script /notify/dir"
 *       }]
 *     }]
 *   }
 * }
 */
export class ClaudeNotificationMonitor
  extends NotificationMonitorBase
  implements INotificationMonitor
{
  /**
   * Monitor for completion notification
   *
   * Delegates to shared CliNotificationMonitor utility for consistent monitoring logic.
   *
   * @param config Monitoring configuration
   * @param sessionId Session ID to match (undefined = wildcard mode)
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
    // Delegate to shared utility for consistent monitoring logic across all CLI providers
    return CliNotificationMonitor.monitorForCompletion(
      config,
      sessionId,
      startTime,
      onCancel
    );
  }

  /**
   * Build hook configuration for Claude CLI
   *
   * Claude uses JSON string (not object) for --settings flag.
   * Settings must be JSON.stringify'd before passing to CLI.
   *
   * Configures both SessionStart and Stop hooks:
   * - SessionStart: Called when new session starts (provides session ID immediately)
   * - Stop: Called when execution completes (for completion detection)
   *
   * @param scriptPath Path to notification handler script
   * @param notifyDir Notification directory
   * @param workspaceRoot Workspace root directory (unused for Claude)
   * @returns Hook configuration as JSON string
   */
  buildHookConfig(
    scriptPath: string,
    notifyDir: string,
    workspaceRoot: string
  ): HookConfig {
    // Convert paths to forward slashes (works on Windows and avoids escaping issues)
    const normalizedScriptPath = scriptPath.replace(/\\/g, "/");
    const normalizedNotifyDir = notifyDir.replace(/\\/g, "/");

    const settings = {
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: "command",
                command: `node "${normalizedScriptPath}" "${normalizedNotifyDir}"`,
              },
            ],
          },
        ],
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command: `node "${normalizedScriptPath}" "${normalizedNotifyDir}"`,
              },
            ],
          },
        ],
      },
    };

    return {
      type: "json-string",
      config: JSON.stringify(settings),
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
      ".flightpath",
      "temp",
      "claude-notifications"
    );
  }

  /**
   * Extract session ID from notification data
   *
   * @param data Notification file content
   * @returns Session ID if found
   */
  extractSessionId(data: any): string | undefined {
    return data?.sessionId;
  }

  /**
   * Wait for SessionStart hook notification and extract session ID
   *
   * Polls notification directory for SessionStart notification file.
   * This is faster and more reliable than searching log files.
   *
   * @param config Monitoring configuration
   * @param startTime Execution start time
   * @param onCancel Cancellation callback
   * @returns Session ID if found, or null on timeout/cancellation
   */
  async waitForSessionStart(
    config: NotificationConfig,
    startTime: Date,
    onCancel?: () => boolean
  ): Promise<string | null> {
    const pollMs = config.pollMs || 100;
    const timeoutMs = config.timeoutMs;
    const startMs = Date.now();

    Log.debug(
      `[ClaudeNotificationMonitor] Waiting for SessionStart notification (timeout: ${timeoutMs}ms)`
    );

    while (Date.now() - startMs < timeoutMs) {
      // Check for cancellation
      if (onCancel && onCancel()) {
        Log.debug("[ClaudeNotificationMonitor] SessionStart wait cancelled");
        return null;
      }

      // Check for any new notification files created after start time
      const files = await this.findNotificationFiles(
        config.directory,
        /\.json$/
      );

      for (const file of files) {
        // Only check files created after start time
        if (await this.isFileNewerThan(file, startTime)) {
          const data = await this.readNotificationFile(file);

          // Check if this is a SessionStart notification
          if (data?.hookEvent === "SessionStart" && data?.sessionId) {
            Log.debug(
              `[ClaudeNotificationMonitor] Found SessionStart notification: ${data.sessionId}`
            );
            return data.sessionId;
          }
        }
      }

      // Wait before next poll
      await this.delay(pollMs);
    }

    Log.warn("[ClaudeNotificationMonitor] SessionStart wait timeout");
    return null;
  }
}
