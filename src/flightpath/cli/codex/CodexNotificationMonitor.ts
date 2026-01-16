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
 * Codex CLI Notification Monitor
 *
 * Monitors for completion via Codex CLI notify hook:
 * - Notify hook writes notification file when execution completes
 * - Notification file contains session ID and timestamp
 * - Supports wildcard mode (sessionId = undefined) for first file detection
 * - Settings format: TOML inline string (notify=['node','path']) for --config flag
 *
 * Hook configuration:
 * notify=['node','/path/to/script']
 *
 * The script receives notification data via stdin and writes a file with:
 * {
 *   "sessionId": "thread_id",
 *   "timestamp": 1234567890,
 *   "event": "notify"
 * }
 */
export class CodexNotificationMonitor
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

    Log.debug(`🔍 Monitoring for Codex completion: ${sessionId || "wildcard"}`);
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
   * Build hook configuration for Codex CLI
   *
   * Codex uses TOML inline string for --config flag.
   * Format: notify=['node','<script-path>']
   *
   * The script receives notification data via stdin (JSON).
   * The script writes a notification file to notifyDir with session ID.
   *
   * @param scriptPath Path to notification handler script
   * @param notifyDir Notification directory
   * @param workspaceRoot Workspace root directory (unused for Codex)
   * @returns Hook configuration as TOML inline string
   */
  buildHookConfig(
    scriptPath: string,
    notifyDir: string,
    workspaceRoot: string
  ): HookConfig {
    // Convert to forward slashes (works on Windows and avoids escaping issues)
    const normalizedPath = scriptPath.replace(/\\/g, "/");

    // TOML array format with single quotes (avoids escaping complexity)
    // Format: notify=['node','path']
    const tomlConfig = `notify=['node','${normalizedPath}']`;

    return {
      type: "toml-inline",
      config: tomlConfig,
    };
  }

  /**
   * Get notification directory for Codex CLI
   *
   * @param workspaceRoot Workspace root
   * @returns Notification directory path
   */
  getNotificationDirectory(workspaceRoot: string): string {
    return path.join(workspaceRoot, ".flightpath", "notify", "codex");
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
