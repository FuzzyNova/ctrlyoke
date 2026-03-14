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
   * Codex includes thread IDs in notification filenames.
   * Files are named: notify-{threadId}.json
   * This enables specific session monitoring (faster, more reliable).
   */
  readonly supportsSessionIdInFilename = true;
  /**
   * Monitor for completion notification
   *
   * Delegates to shared CliNotificationMonitor utility.
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
    return CliNotificationMonitor.monitorForCompletion(
      config,
      sessionId,
      startTime,
      onCancel
    );
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
   * Uses shared pattern: {workspace}/.flightpath/temp/codex-notifications/
   *
   * @param workspaceRoot Workspace root
   * @returns Notification directory path
   */
  getNotificationDirectory(workspaceRoot: string): string {
    return CliNotificationMonitor.getNotificationDirectory(
      workspaceRoot,
      "codex"
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
   * Codex CLI does not support SessionStart hooks.
   * CliIntegration checks this flag to skip waitForSessionStart and fall through
   * to log file discovery as the session-start proxy instead.
   */
  override readonly supportsSessionStart = false;
}
