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
   * Claude-specific implementation that monitors for {sessionId}-stop.json files
   * (separate from -start.json to avoid race conditions)
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
    const pollMs = config.pollMs || 500;

    Log.debug(
      `[ClaudeNotificationMonitor] Monitoring for Stop hook (session: ${sessionId || "wildcard"})`
    );

    // Poll for -stop.json notification file
    while (Date.now() - startTime.getTime() < config.timeoutMs) {
      // Check for cancellation
      if (onCancel && onCancel()) {
        Log.info("🛑 User cancelled - stopping Stop hook monitoring");
        return {
          completed: false,
          error: "User cancelled execution",
        };
      }

      try {
        if (sessionId) {
          // Monitor for specific {sessionId}-stop.json file
          const stopFile = path.join(
            config.directory,
            `${sessionId}-stop.json`
          );
          const data = await this.readNotificationFile(stopFile);

          if (data?.hookEvent === "Stop" && data?.status === "completed") {
            Log.info(
              `✅ Completion detected via Stop hook (session: ${sessionId})`
            );
            // Delete the -stop.json file immediately
            try {
              const fs = await import("fs");
              await fs.promises.unlink(stopFile);
              Log.debug("🗑️ Cleaned up Stop notification file");
            } catch (error) {
              Log.debug(`Failed to cleanup Stop file: ${error}`);
            }
            return { completed: true, data };
          }
        } else {
          // Wildcard mode: look for any new -stop.json file
          const files = await this.findNotificationFiles(
            config.directory,
            /-stop\.json$/
          );

          for (const file of files) {
            if (await this.isFileNewerThan(file, startTime)) {
              const data = await this.readNotificationFile(file);

              if (data?.hookEvent === "Stop" && data?.status === "completed") {
                Log.info(
                  `✅ Completion detected via Stop hook (file: ${file})`
                );
                // Delete the file
                try {
                  const fs = await import("fs");
                  await fs.promises.unlink(file);
                  Log.debug("🗑️ Cleaned up Stop notification file");
                } catch (error) {
                  Log.debug(`Failed to cleanup Stop file: ${error}`);
                }
                return { completed: true, data };
              }
            }
          }
        }
      } catch (error) {
        Log.debug(`Stop notification check error: ${error}`);
      }

      // Wait before next check
      await this.delay(pollMs);
    }

    // Timeout reached
    Log.warn(`⏱️ Stop hook monitoring timed out`);
    return {
      completed: false,
      error: "Timeout waiting for Stop hook notification",
    };
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
   * Cleanup notification files after completion
   *
   * Cleans up the SessionStart notification file (-start.json).
   * The Stop notification file (-stop.json) is already cleaned up by monitorForCompletion().
   *
   * @param sessionId Session ID
   * @param directory Notification directory
   */
  async cleanupNotificationFiles(
    sessionId: string,
    directory: string
  ): Promise<void> {
    const startFile = path.join(directory, `${sessionId}-start.json`);
    try {
      const fs = await import("fs");
      await fs.promises.unlink(startFile);
      Log.debug("🗑️ Cleaned up SessionStart notification file");
    } catch (error) {
      // Ignore errors - file might not exist or already deleted
      Log.debug(`SessionStart file cleanup skipped: ${error}`);
    }
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
   * @returns NotificationResult with session ID in data.sessionId
   */
  async waitForSessionStart(
    config: NotificationConfig,
    startTime: Date,
    onCancel?: () => boolean
  ): Promise<NotificationResult> {
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
        return {
          completed: false,
          error: "User cancelled execution",
        };
      }

      // Check for any new SessionStart notification files created after start time
      // Look specifically for *-start.json files to avoid conflicts with Stop hooks
      const files = await this.findNotificationFiles(
        config.directory,
        /-start\.json$/
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
            // NOTE: We read but DON'T delete the -start.json file yet
            // It will be cleaned up when Stop hook completes
            return {
              completed: true,
              data: { sessionId: data.sessionId },
            };
          }
        }
      }

      // Wait before next poll
      await this.delay(pollMs);
    }

    Log.warn("[ClaudeNotificationMonitor] SessionStart wait timeout");
    return {
      completed: false,
      error: "Timeout waiting for SessionStart notification",
    };
  }
}
