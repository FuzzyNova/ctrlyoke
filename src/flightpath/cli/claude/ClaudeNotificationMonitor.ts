import * as path from "path";
import {
  INotificationMonitor,
  NotificationConfig,
  NotificationResult,
  HookConfig,
  NotificationMonitorBase,
} from "../shared/interfaces/INotificationMonitor";
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
   * Polls notification directory for files matching session ID.
   * Supports wildcard mode (sessionId = undefined) to detect any completion.
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
    const fs = require("fs/promises");
    const pollInterval = config.pollMs || 250; // Default 250ms
    const startTimeMs = startTime.getTime();
    const timeoutMs = config.timeoutMs;

    Log.debug(
      `🔍 Monitoring for Claude completion: ${sessionId || "wildcard"}`
    );
    Log.debug(`   Directory: ${config.directory}`);
    Log.debug(`   Timeout: ${timeoutMs}ms`);

    // Ensure notification directory exists
    try {
      await fs.mkdir(config.directory, { recursive: true });
    } catch (error) {
      return {
        completed: false,
        error: `Failed to create notification directory: ${error}`,
      };
    }

    while (true) {
      // Check for cancellation
      if (onCancel?.()) {
        Log.debug("⏹️ Notification monitoring cancelled");
        return { completed: false, error: "Cancelled by user" };
      }

      // Check timeout
      const elapsedMs = Date.now() - startTimeMs;
      if (elapsedMs >= timeoutMs) {
        Log.debug("⏱️ Notification monitoring timed out");
        return {
          completed: false,
          error: `Timeout after ${timeoutMs}ms`,
        };
      }

      // Scan for notification files
      try {
        const files = await fs.readdir(config.directory);
        const notifyFiles = files.filter((f: string) =>
          f.startsWith("notify-")
        );

        for (const file of notifyFiles) {
          const filePath = path.join(config.directory, file);
          let fileContent: string;

          try {
            fileContent = await fs.readFile(filePath, "utf-8");
          } catch (readError) {
            Log.debug(`Failed to read notification file: ${readError}`);
            continue;
          }

          // Parse notification data
          let data: any;
          try {
            data = JSON.parse(fileContent);
          } catch (parseError) {
            Log.debug(`Failed to parse notification file: ${parseError}`);
            continue;
          }

          // Check if this notification matches our session (or wildcard mode)
          if (sessionId === undefined || data.sessionId === sessionId) {
            Log.debug(`✅ Found matching notification: ${file}`);
            Log.debug(`   Session ID: ${data.sessionId}`);

            // Clean up notification file
            try {
              await fs.unlink(filePath);
            } catch (unlinkError) {
              Log.debug(`Failed to clean up notification file: ${unlinkError}`);
            }

            return {
              completed: true,
              data,
            };
          }
        }
      } catch (error) {
        Log.debug(`Error scanning notification directory: ${error}`);
      }

      // Wait before next poll
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }
  }

  /**
   * Build hook configuration for Claude CLI
   *
   * Claude uses JSON string (not object) for --settings flag.
   * Settings must be JSON.stringify'd before passing to CLI.
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
    return path.join(workspaceRoot, ".flightpath", "temp", "notify-claude");
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
}
