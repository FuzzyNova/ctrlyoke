/**
 * Notification monitoring configuration
 */
export interface NotificationConfig {
  /** Directory to watch for notification files */
  directory: string;

  /** Polling interval in milliseconds (optional) */
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

  /** Error message if monitoring failed */
  error?: string;

  /** Notification data if found */
  data?: any;
}

/**
 * Hook configuration result (varies by CLI)
 *
 * Different CLIs use different configuration formats:
 * - Copilot: JSON object
 * - Claude: JSON string
 * - Codex: TOML inline string
 */
export type HookConfig =
  | { type: "json"; config: object } // Copilot: JSON object
  | { type: "json-string"; config: string } // Claude: JSON string
  | { type: "toml-inline"; config: string } // Codex: TOML inline
  | { type: "none" }; // No hook support

/**
 * Notification monitoring interface
 *
 * Each CLI harness implements this to monitor for completion notifications
 * in their specific format (sessionEnd hooks, notify callbacks, etc.)
 */
export interface INotificationMonitor {
  /**
   * Whether this harness includes session IDs in notification filenames.
   *
   * - `true`: Notification files include session ID (e.g., Claude: `stop-{threadId}.json`)
   * - `false`: Notification files use timestamps (e.g., Copilot: `sessionEnd-{timestamp}.json`)
   *
   * This determines the monitoring mode:
   * - When true: Use specific session monitoring (faster, more reliable)
   * - When false: Use wildcard monitoring (any new file triggers completion)
   */
  readonly supportsSessionIdInFilename: boolean;

  /**
   * Monitor for completion notification
   * @param config Monitoring configuration
   * @param sessionId Optional session/thread ID (undefined = wildcard mode)
   * @param startTime Execution start time
   * @param onCancel Cancellation callback
   * @returns Monitoring result
   */
  monitorForCompletion(
    config: NotificationConfig,
    sessionId: string | undefined,
    startTime: Date,
    onCancel?: () => boolean
  ): Promise<NotificationResult>;

  /**
   * Build hook/notification configuration
   * @param scriptPath Path to notification handler script
   * @param notifyDir Notification directory
   * @param workspaceRoot Workspace root directory
   * @returns Hook configuration (format varies by CLI)
   */
  buildHookConfig(
    scriptPath: string,
    notifyDir: string,
    workspaceRoot: string
  ): HookConfig;

  /**
   * Get notification directory for this CLI
   * @param workspaceRoot Workspace root
   * @returns Notification directory path
   */
  getNotificationDirectory(workspaceRoot: string): string;

  /**
   * Extract session/thread ID from notification data
   * @param data Notification file content
   * @returns Session ID if found
   */
  extractSessionId?(data: any): string | undefined;

  /**
   * Wait for session start notification and extract session ID
   *
   * This method waits for the SessionStart hook to fire.
   * This is faster and more reliable than searching log files.
   *
   * @param config Monitoring configuration
   * @param startTime Execution start time
   * @param onCancel Cancellation callback
   * @returns NotificationResult with session ID in data.sessionId (if provided by CLI)
   */
  waitForSessionStart?(
    config: NotificationConfig,
    startTime: Date,
    onCancel?: () => boolean
  ): Promise<NotificationResult>;

  /**
   * Cleanup notification files after completion
   *
   * Called after completion is detected to clean up any remaining notification files.
   * Harnesses can override this to handle harness-specific cleanup
   * (e.g., Claude needs to cleanup both -start.json and -stop.json files)
   *
   * @param sessionId Session ID
   * @param directory Notification directory
   */
  cleanupNotificationFiles?(
    sessionId: string,
    directory: string
  ): Promise<void>;
}

/**
 * Shared utilities for notification monitors (optional base class)
 *
 * Provides common utilities for file-based notification monitoring.
 * Providers can extend this class to avoid duplicating polling logic.
 */
export abstract class NotificationMonitorBase implements INotificationMonitor {
  abstract readonly supportsSessionIdInFilename: boolean;

  abstract monitorForCompletion(
    config: NotificationConfig,
    sessionId: string | undefined,
    startTime: Date,
    onCancel?: () => boolean
  ): Promise<NotificationResult>;

  abstract buildHookConfig(
    scriptPath: string,
    notifyDir: string,
    workspaceRoot: string
  ): HookConfig;

  abstract getNotificationDirectory(workspaceRoot: string): string;

  /**
   * Simple delay utility
   * @param ms Milliseconds to wait
   */
  protected delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Read and parse JSON notification file
   * @param filePath Path to notification file
   * @returns Parsed JSON data or null if not found/invalid
   */
  protected async readNotificationFile(filePath: string): Promise<any | null> {
    try {
      const fs = await import("fs");
      const content = fs.readFileSync(filePath, "utf-8");
      return JSON.parse(content);
    } catch (error) {
      return null;
    }
  }

  /**
   * Check for specific notification file
   * @param directory Notification directory
   * @param fileName File name to check
   * @returns Notification result
   */
  protected async checkSpecificFile(
    directory: string,
    fileName: string
  ): Promise<NotificationResult> {
    const path = require("path");
    const filePath = path.join(directory, fileName);

    const data = await this.readNotificationFile(filePath);
    if (data) {
      return { completed: true, data };
    }

    return { completed: false };
  }

  /**
   * Find notification files matching a pattern
   * @param directory Directory to search
   * @param pattern File name pattern (regex)
   * @returns Array of matching file paths
   */
  protected async findNotificationFiles(
    directory: string,
    pattern: RegExp
  ): Promise<string[]> {
    try {
      const fs = await import("fs");
      const files = fs.readdirSync(directory);
      const path = require("path");

      return files
        .filter((file) => pattern.test(file))
        .map((file) => path.join(directory, file));
    } catch {
      return [];
    }
  }

  /**
   * Check if notification file is newer than start time
   * @param filePath File path
   * @param startTime Execution start time
   * @returns True if file is newer
   */
  protected async isFileNewerThan(
    filePath: string,
    startTime: Date
  ): Promise<boolean> {
    try {
      const fs = await import("fs");
      const stats = fs.statSync(filePath);
      return stats.mtime > startTime;
    } catch {
      return false;
    }
  }
}
