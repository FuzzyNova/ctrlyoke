import * as path from "path";
import * as fs from "fs";
import {
  INotificationMonitor,
  NotificationConfig,
  NotificationResult,
  HookConfig,
} from "../shared/interfaces/INotificationMonitor";
import { Log } from "../../../utils/Log";

/**
 * Copilot CLI Notification Monitor
 *
 * Monitors for completion via sessionEnd hooks:
 * - Hook file: .github/hooks/flightpath.json
 * - Hook script: flightpath-copilot-hook.js (writes notification files)
 * - Notification directory: .flightpath/notify-copilot/
 * - Detection: File-based polling for completion notifications
 *
 * Note: Copilot hooks do NOT provide session IDs in notifications.
 * Session IDs must be extracted from process log files separately.
 */
export class CopilotNotificationMonitor implements INotificationMonitor {
  /**
   * Monitor for completion notification
   *
   * Polls notification directory for files created by sessionEnd hook.
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
    const pollMs = config.pollMs || 100;
    const endTime = new Date(startTime.getTime() + config.timeoutMs);

    Log.debug(
      `🔔 Monitoring ${config.directory} for completion notifications...`
    );

    while (new Date() < endTime) {
      // Check cancellation
      if (onCancel?.()) {
        return {
          completed: false,
          error: "Monitoring cancelled by user",
        };
      }

      // Look for notification files in directory
      try {
        if (!fs.existsSync(config.directory)) {
          await this.delay(pollMs);
          continue;
        }

        const files = fs.readdirSync(config.directory);

        // Filter for JSON files created after start time
        for (const file of files) {
          if (!file.endsWith(".json")) {
            continue;
          }

          const filePath = path.join(config.directory, file);
          const stats = fs.statSync(filePath);

          // Only consider files created after execution started
          if (stats.mtime < startTime) {
            continue;
          }

          // Read notification data
          const data = await this.readNotificationFile(filePath);
          if (!data) {
            continue;
          }

          // Wildcard mode: Accept any notification file
          // (Copilot hooks don't provide session IDs)
          if (!sessionId) {
            Log.debug(`✅ Completion detected (wildcard mode): ${file}`);
            return { completed: true, data };
          }

          // Session ID mode: Match specific session (if provided)
          const notificationSessionId = this.extractSessionId?.(data);
          if (notificationSessionId === sessionId) {
            Log.debug(`✅ Completion detected for session: ${sessionId}`);
            return { completed: true, data };
          }
        }
      } catch (error) {
        Log.debug(`⚠️ Error reading notification directory: ${error}`);
      }

      await this.delay(pollMs);
    }

    return {
      completed: false,
      error: "Timeout waiting for completion notification",
    };
  }

  /**
   * Build Copilot hook configuration
   *
   * Creates JSON object for .github/hooks/flightpath.json with sessionEnd hook.
   * The hook calls a Node.js script that writes notification files.
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
   * @param workspaceRoot Workspace root directory
   * @returns Notification directory path (.flightpath/notify-copilot/)
   */
  getNotificationDirectory(workspaceRoot: string): string {
    return path.join(workspaceRoot, ".flightpath", "notify-copilot");
  }

  /**
   * Extract session ID from notification data
   *
   * Note: Copilot sessionEnd hooks do NOT provide session IDs in notifications.
   * Always returns undefined. Session IDs must be extracted from log files.
   *
   * @param data Notification file content
   * @returns Always undefined (session IDs not in Copilot notifications)
   */
  extractSessionId?(data: any): string | undefined {
    // Copilot hooks don't include session IDs in notifications
    return undefined;
  }

  /**
   * Simple delay utility
   * @param ms Milliseconds to wait
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Read and parse JSON notification file
   * @param filePath Path to notification file
   * @returns Parsed JSON data or null if error
   */
  private async readNotificationFile(filePath: string): Promise<any | null> {
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      return JSON.parse(content);
    } catch (error) {
      Log.debug(`Failed to read notification file: ${filePath}`);
      return null;
    }
  }
}
