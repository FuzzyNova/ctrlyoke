import * as fs from "fs";
import * as path from "path";
import { Log } from "../../../utils/Log";
import { readJsonFileAndDelete } from "../../../utils/FileSystemUtils";
import {
  NotificationConfig,
  NotificationResult,
} from "./interfaces/INotificationMonitor";

// Re-export for consumers that import from this file
export type { NotificationConfig, NotificationResult };

/**
 * Shared hook/notification file monitoring utilities
 *
 * Used by CLI integrations that support hooks for completion detection:
 * - Copilot CLI: sessionEnd hook (writes session-{id}.json when session completes)
 * - Claude CLI: Stop hook (writes session-{id}.json when agent stops)
 * - Codex CLI: Notify hook (writes thread-{id}.json on agent-turn-complete)
 */
export class CliNotificationMonitor {
  /**
   * Monitor notification directory for completion
   *
   * Polls the directory for a notification file:
   * - If sessionId provided: monitors for specific file (e.g., session-123.json)
   * - If sessionId is undefined: monitors for ANY new file (wildcard mode)
   *
   * Wildcard mode is useful when session ID is not immediately available
   * but we're the only process running, so any new file indicates completion.
   *
   * @param config Monitoring configuration
   * @param sessionId Optional session/thread ID to monitor (undefined = wildcard mode)
   * @param startTime Execution start time for timeout calculation
   * @param onCancel Optional callback to check if user cancelled
   * @returns Monitoring result with completion status
   */
  static async monitorForCompletion(
    config: NotificationConfig,
    sessionId: string | undefined,
    startTime: Date,
    onCancel?: () => boolean
  ): Promise<NotificationResult> {
    const pollMs = config.pollMs || 500;

    // Ensure notification directory exists
    if (!fs.existsSync(config.directory)) {
      fs.mkdirSync(config.directory, { recursive: true });
    }

    // Get initial file list to detect new files
    let initialFiles = new Set<string>();
    try {
      const files = fs.readdirSync(config.directory);
      initialFiles = new Set(files);
      Log.debug(`📋 Initial notification files: ${files.length}`);
    } catch (error) {
      Log.debug(`Could not read notification directory: ${error}`);
    }

    if (sessionId) {
      Log.debug(`📋 Monitoring notification file for session: ${sessionId}`);
    } else {
      Log.debug(
        `📋 Monitoring notification directory for any new completion file`
      );
    }

    // Poll for notification file
    while (Date.now() - startTime.getTime() < config.timeoutMs) {
      // Check for cancellation
      if (onCancel && onCancel()) {
        Log.info("🛑 User cancelled - stopping notification monitoring");
        return {
          completed: false,
          error: "User cancelled execution",
        };
      }

      try {
        if (sessionId) {
          // Monitor specific session ID file
          const result = await this.checkSpecificFile(
            config.directory,
            sessionId
          );
          if (result.completed) {
            return result;
          }
        } else {
          // Monitor for any new notification file
          const result = await this.checkForNewFile(
            config.directory,
            initialFiles
          );
          if (result.completed) {
            return result;
          }
        }
      } catch (error) {
        Log.debug(`Notification file check error: ${error}`);
      }

      // Wait before next check
      await this.delay(pollMs);
    }

    // Timeout reached
    Log.warn(`⏱️ Notification file monitoring timed out`);
    return {
      completed: false,
      error: "Timeout waiting for completion notification",
    };
  }

  /**
   * Check for a specific notification file
   *
   * @param directory Notification directory
   * @param sessionId Session/thread ID
   * @returns Result with completion status
   */
  private static async checkSpecificFile(
    directory: string,
    sessionId: string
  ): Promise<NotificationResult> {
    const notifyFile = path.join(directory, `${sessionId}.json`);
    const notifyData = await this.readAndCleanupNotificationFile(notifyFile);

    if (notifyData) {
      Log.info(
        `✅ Completion detected via hook (session: ${notifyData.sessionId || notifyData.threadId || sessionId})`
      );
      return { completed: true, data: notifyData };
    }

    return { completed: false };
  }

  /**
   * Check for any new notification file
   *
   * @param directory Notification directory
   * @param initialFiles Initial file list (to detect new files)
   * @returns Result with completion status
   */
  private static async checkForNewFile(
    directory: string,
    initialFiles: Set<string>
  ): Promise<NotificationResult> {
    try {
      const currentFiles = fs.readdirSync(directory);

      for (const file of currentFiles) {
        if (!initialFiles.has(file) && file.endsWith(".json")) {
          const notifyFile = path.join(directory, file);
          const notifyData =
            await this.readAndCleanupNotificationFile(notifyFile);

          if (notifyData) {
            Log.info(
              `✅ Completion detected via hook (file: ${file}, session: ${notifyData.sessionId || notifyData.threadId})`
            );

            // Log additional details if available
            if (notifyData.lastMessage) {
              Log.debug(`📝 Last message: ${notifyData.lastMessage}`);
            }
            if (notifyData.turnId) {
              Log.debug(`🔄 Turn ID: ${notifyData.turnId}`);
            }

            return { completed: true, data: notifyData };
          }
        }
      }
    } catch (error) {
      Log.debug(`Error reading notification directory: ${error}`);
    }

    return { completed: false };
  }

  /**
   * Read and cleanup notification file.
   * Delegates to FileSystemUtils for actual read/delete operation.
   *
   * @param notifyFile Path to notification file
   * @returns Parsed notification data, or null if file doesn't exist or is invalid
   */
  private static async readAndCleanupNotificationFile(
    notifyFile: string
  ): Promise<any | null> {
    return await readJsonFileAndDelete(notifyFile);
  }

  /**
   * Simple delay utility
   *
   * @param ms Milliseconds to delay
   */
  private static delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Get workspace-specific notification directory
   *
   * Uses pattern: {workspace}/.flightpath/temp/{cli}-notifications/
   * This prevents conflicts when multiple VS Code instances run FlightPath.
   *
   * @param workspaceRoot Workspace root directory
   * @param cliName CLI name (e.g., "claude", "codex")
   * @returns Notification directory path
   */
  static getNotificationDirectory(
    workspaceRoot: string,
    cliName: string
  ): string {
    return path.join(
      workspaceRoot,
      ".flightpath",
      "temp",
      `${cliName}-notifications`
    );
  }

  // Harness-specific hook config builders moved to:
  // - CopilotNotificationMonitor.buildCopilotHookConfig()
  // - ClaudeNotificationMonitor.buildClaudeStopHookSettings()
  // - CodexNotificationMonitor.buildCodexNotifyConfig()
}
