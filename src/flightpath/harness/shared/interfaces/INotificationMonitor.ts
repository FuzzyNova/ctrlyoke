import * as fs from "fs";
import * as path from "path";
import { Log } from "../../../../utils/Log";

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
   * - `true`: Notification files include session ID (e.g., Claude: `{threadId}-stop.json`)
   * - `false`: Notification files use timestamps (wildcard monitoring required)
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
   * (e.g., deleting the -start.json file that was left from session start)
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
 * Standard notification monitor base class
 *
 * Implements all monitoring logic for harnesses that use the standardized
 * two-file notification format:
 *
 *   {sessionId}-start.json → { hookEvent: "SessionStart", sessionId, status: "started" }
 *   {sessionId}-stop.json  → { hookEvent: "Stop", sessionId, status: "completed" }
 *
 * Currently used by: Copilot CLI, Claude CLI
 *
 * Harnesses with a different format (e.g., Codex: notify-{id}.json) extend this
 * class and override monitorForCompletion() only. The file utilities and other
 * concrete methods remain available.
 *
 * Abstract requirements (must implement in subclass):
 * - buildHookConfig()      — CLI-specific hook registration format
 * - getNotificationDirectory() — CLI-specific notification path
 */
export abstract class NotificationMonitorBase implements INotificationMonitor {
  /**
   * Standard harnesses include session IDs in notification filenames.
   * Override to false for harnesses that use timestamp-based filenames.
   */
  readonly supportsSessionIdInFilename: boolean = true;

  // ── Abstract (CLI-specific) ──────────────────────────────────────────────

  abstract buildHookConfig(
    scriptPath: string,
    notifyDir: string,
    workspaceRoot: string
  ): HookConfig;

  abstract getNotificationDirectory(workspaceRoot: string): string;

  // ── Concrete (shared two-file format) ────────────────────────────────────

  /**
   * Extract session ID from standard notification data.
   */
  extractSessionId(data: any): string | undefined {
    return data?.sessionId;
  }

  /**
   * Monitor for completion via {sessionId}-stop.json with hookEvent: "Stop".
   *
   * When sessionId is provided: polls {sessionId}-stop.json directly.
   * When sessionId is undefined (wildcard): scans for any *-stop.json newer than startTime.
   *
   * Deletes the stop file when completion is confirmed.
   */
  async monitorForCompletion(
    config: NotificationConfig,
    sessionId: string | undefined,
    startTime: Date,
    onCancel?: () => boolean
  ): Promise<NotificationResult> {
    const pollMs = config.pollMs || 500;

    Log.debug(
      `[NotificationMonitorBase] Monitoring for Stop hook (session: ${sessionId || "wildcard"})`
    );

    while (Date.now() - startTime.getTime() < config.timeoutMs) {
      if (onCancel?.()) {
        Log.debug("⏹️ Stop hook monitoring stopped (cancelled or already completed)");
        return { completed: false, error: "Execution cancelled" };
      }

      try {
        if (sessionId) {
          const stopFile = path.join(config.directory, `${sessionId}-stop.json`);
          const data = await this.readNotificationFile(stopFile);

          if (data?.hookEvent === "Stop" && data?.status === "completed") {
            Log.info(`✅ Completion detected via Stop hook (session: ${sessionId})`);
            try {
              fs.unlinkSync(stopFile);
              Log.debug("🗑️ Cleaned up Stop notification file");
            } catch (error) {
              Log.debug(`Failed to cleanup Stop file: ${error}`);
            }
            return { completed: true, data };
          }
        } else {
          const files = await this.findNotificationFiles(
            config.directory,
            /-stop\.json$/
          );

          for (const file of files) {
            if (await this.isFileNewerThan(file, startTime)) {
              const data = await this.readNotificationFile(file);

              if (data?.hookEvent === "Stop" && data?.status === "completed") {
                Log.info(`✅ Completion detected via Stop hook (file: ${file})`);
                try {
                  fs.unlinkSync(file);
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

      await this.delay(pollMs);
    }

    Log.warn(`⏱️ Stop hook monitoring timed out`);
    return {
      completed: false,
      error: "Timeout waiting for Stop hook notification",
    };
  }

  /**
   * Wait for session start via {sessionId}-start.json with hookEvent: "SessionStart".
   *
   * Scans for any *-start.json file newer than startTime.
   * Does NOT delete the file — cleanupNotificationFiles() handles it after completion.
   *
   * Returns the full notification data; callers use data.sessionId.
   */
  async waitForSessionStart(
    config: NotificationConfig,
    startTime: Date,
    onCancel?: () => boolean
  ): Promise<NotificationResult> {
    const pollMs = config.pollMs || 100;

    Log.debug(
      `[NotificationMonitorBase] Waiting for SessionStart notification (timeout: ${config.timeoutMs}ms)`
    );

    while (Date.now() - startTime.getTime() < config.timeoutMs) {
      if (onCancel?.()) {
        Log.debug("[NotificationMonitorBase] SessionStart wait cancelled");
        return { completed: false, error: "User cancelled execution" };
      }

      const files = await this.findNotificationFiles(
        config.directory,
        /-start\.json$/
      );

      for (const file of files) {
        if (await this.isFileNewerThan(file, startTime)) {
          const data = await this.readNotificationFile(file);

          if (data?.hookEvent === "SessionStart" && data?.sessionId) {
            Log.debug(
              `[NotificationMonitorBase] Found SessionStart notification: ${data.sessionId}`
            );
            // NOTE: Do NOT delete — cleanupNotificationFiles() removes it after completion
            return { completed: true, data };
          }
        }
      }

      await this.delay(pollMs);
    }

    Log.warn("[NotificationMonitorBase] SessionStart wait timeout");
    return {
      completed: false,
      error: "Timeout waiting for SessionStart notification",
    };
  }

  /**
   * Cleanup the {sessionId}-start.json file after session completion.
   * The stop file is already deleted by monitorForCompletion().
   */
  async cleanupNotificationFiles(
    sessionId: string,
    directory: string
  ): Promise<void> {
    const startFile = path.join(directory, `${sessionId}-start.json`);
    try {
      fs.unlinkSync(startFile);
      Log.debug("🗑️ Cleaned up SessionStart notification file");
    } catch (error) {
      // Ignore — file might not exist or already deleted
      Log.debug(`SessionStart file cleanup skipped: ${error}`);
    }
  }

  // ── Protected helpers ────────────────────────────────────────────────────

  /**
   * Simple delay utility
   */
  protected delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Read and parse a JSON notification file WITHOUT deleting it.
   * Returns null if the file doesn't exist or contains invalid JSON.
   */
  protected async readNotificationFile(filePath: string): Promise<any | null> {
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  /**
   * Find notification files matching a pattern in a directory.
   * Returns empty array if the directory doesn't exist or is unreadable.
   */
  protected async findNotificationFiles(
    directory: string,
    pattern: RegExp
  ): Promise<string[]> {
    try {
      const files = fs.readdirSync(directory);
      return files
        .filter((file) => pattern.test(file))
        .map((file) => path.join(directory, file));
    } catch {
      return [];
    }
  }

  /**
   * Check if a notification file was modified after the given start time.
   */
  protected async isFileNewerThan(
    filePath: string,
    startTime: Date
  ): Promise<boolean> {
    try {
      const stats = fs.statSync(filePath);
      return stats.mtime > startTime;
    } catch {
      return false;
    }
  }
}
