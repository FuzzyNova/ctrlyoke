import * as fs from "fs";
import * as path from "path";
import { Log } from "../../../utils/Log";

/**
 * Notification monitoring configuration
 */
export interface NotificationConfig {
  /** Directory where notification files are written */
  directory: string;
  /** Poll interval in milliseconds (default: 500ms) */
  pollMs?: number;
  /** Timeout in milliseconds */
  timeoutMs: number;
}

/**
 * Notification monitoring result
 */
export interface NotificationResult {
  /** Whether completion was detected */
  completed: boolean;
  /** Optional error message if completion failed */
  error?: string;
  /** Notification data if successful */
  data?: any;
}

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

    if (fs.existsSync(notifyFile)) {
      try {
        // Read notification data
        const notifyData = JSON.parse(fs.readFileSync(notifyFile, "utf8"));

        Log.info(
          `✅ Completion detected via hook (session: ${notifyData.sessionId || notifyData.threadId || sessionId})`
        );

        // Clean up notification file
        try {
          fs.unlinkSync(notifyFile);
          Log.debug(`🗑️ Cleaned up notification file`);
        } catch (cleanupError) {
          Log.debug(`Failed to clean up notification file: ${cleanupError}`);
        }

        return { completed: true, data: notifyData };
      } catch (parseError) {
        Log.debug(`Failed to parse notification file: ${parseError}`);
        return { completed: false };
      }
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

          try {
            const notifyData = JSON.parse(fs.readFileSync(notifyFile, "utf8"));

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

            // Clean up notification file
            try {
              fs.unlinkSync(notifyFile);
              Log.debug(`🗑️ Cleaned up notification file: ${file}`);
            } catch (cleanupError) {
              Log.debug(
                `Failed to clean up notification file: ${cleanupError}`
              );
            }

            return { completed: true, data: notifyData };
          } catch (parseError) {
            Log.debug(
              `Failed to parse notification file ${file}: ${parseError}`
            );
            // Continue checking other files
          }
        }
      }
    } catch (error) {
      Log.debug(`Error reading notification directory: ${error}`);
    }

    return { completed: false };
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
   * Extract session ID from CLI output
   *
   * Tries various patterns:
   * - JSON field: "session_id": "abc123"
   * - Log format: session_id: abc123 or session-id: abc123
   *
   * @param output CLI output (stdout or terminal output)
   * @returns Session ID if found
   */
  static extractSessionId(output: string): string | undefined {
    // Try JSON format first
    const sessionMatch = output.match(/"session_id"\s*:\s*"([^"]+)"/i);
    if (sessionMatch) {
      return sessionMatch[1];
    }

    // Try log format
    const sessionLogMatch = output.match(/session[_\s-]id[:\s]+([a-f0-9-]+)/i);
    if (sessionLogMatch) {
      return sessionLogMatch[1];
    }

    return undefined;
  }

  /**
   * Extract thread ID from CLI output
   *
   * Tries various patterns:
   * - JSON field: "thread_id": "abc123"
   * - JSONL event: {"type":"thread.started","thread_id":"abc123"}
   *
   * @param output CLI output (stdout or terminal output)
   * @returns Thread ID if found
   */
  static extractThreadId(output: string): string | undefined {
    // Try JSONL thread.started event
    const threadMatch = output.match(
      /"type"\s*:\s*"thread\.started"[^}]*"thread_id"\s*:\s*"([^"]+)"/i
    );
    if (threadMatch) {
      return threadMatch[1];
    }

    // Try simple JSON field
    const simpleMatch = output.match(/"thread_id"\s*:\s*"([^"]+)"/i);
    if (simpleMatch) {
      return simpleMatch[1];
    }

    return undefined;
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

  // Provider-specific hook config builders moved to:
  // - CopilotNotificationMonitor.buildCopilotHookConfig()
  // - ClaudeNotificationMonitor.buildClaudeStopHookSettings()
  // - CodexNotificationMonitor.buildCodexNotifyConfig()
}
