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
import type { ChildProcess } from "child_process";

/**
 * Qwen Code CLI Notification Monitor
 *
 * Monitors for completion via:
 * - **Headless mode**: Process exit detection (primary method)
 * - **Interactive mode**: Log file monitoring with inactivity timeout (Phase 2)
 *
 * Qwen Code does NOT support stable session lifecycle hooks (Phase 3).
 * Process exit is the primary completion signal for headless mode.
 *
 * Hook configuration: Not supported in Phase 1/2 (hooks are experimental in Qwen).
 */
export class QwenNotificationMonitor
  extends NotificationMonitorBase
  implements INotificationMonitor
{
  /**
   * Qwen does NOT include session IDs in notification filenames.
   * Hooks are not implemented in Phase 1/2.
   * Completion is detected via process exit (headless) or log file polling (interactive).
   */
  readonly supportsSessionIdInFilename = false;

  /**
   * Qwen does NOT support SessionStart hooks in Phase 1/2.
   * CliIntegration checks this flag to skip waitForSessionStart and fall through
   * to log file discovery as the session-start proxy instead.
   */
  override readonly supportsSessionStart = false;

  /**
   * Monitor for completion via process exit (headless mode)
   *
   * In headless mode, Qwen CLI runs non-interactively and exits when complete.
   * We listen for the 'exit' event on the child process.
   *
   * For interactive mode, log file monitoring should be used instead
   * (implemented in Phase 2 with inactivity timeout).
   *
   * @param config Monitoring configuration
   * @param sessionId Session ID (not used for process exit detection)
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
    // Note: Process exit monitoring is handled by CliIntegration
    // This method is a fallback for interactive mode (Phase 2: log file polling)
    // For now, return timeout result as process exit is the primary method
    Log.debug(
      `[QwenNotificationMonitor] Process exit is primary completion detection method`
    );

    // Phase 2: Implement log file polling for interactive mode
    // For now, return a result that indicates monitoring is not applicable
    return {
      completed: false,
      error: "Process exit detection handled by CliIntegration",
    };
  }

  /**
   * Build hook configuration for Qwen Code CLI
   *
   * Qwen Code hooks are experimental and undocumented in Phase 1/2.
   * This method returns a "none" configuration.
   *
   * Phase 3 will implement hook support when Qwen stabilizes the API.
   *
   * @param scriptPath Path to notification handler script
   * @param notifyDir Notification directory
   * @param workspaceRoot Workspace root directory
   * @returns Hook configuration (none for Phase 1/2)
   */
  buildHookConfig(
    scriptPath: string,
    notifyDir: string,
    workspaceRoot: string
  ): HookConfig {
    // Hooks not supported in Phase 1/2
    return {
      type: "none",
    };
  }

  /**
   * Get notification directory for Qwen Code CLI
   *
   * Uses shared pattern: {workspace}/.flightpath/temp/qwen-notifications/
   *
   * @param workspaceRoot Workspace root
   * @returns Notification directory path
   */
  getNotificationDirectory(workspaceRoot: string): string {
    return CliNotificationMonitor.getNotificationDirectory(
      workspaceRoot,
      "qwen"
    );
  }

  /**
   * Monitor process exit for completion (headless mode)
   *
   * This is the primary completion detection method for Qwen CLI.
   * Listens for the 'exit' event on the child process.
   *
   * @param process The child process running Qwen CLI
   * @param onComplete Callback when process exits successfully
   * @param onError Callback when process exits with error
   * @returns Cleanup function to remove event listeners
   */
  monitorProcessExit(
    process: ChildProcess,
    onComplete: () => void,
    onError: (error: Error) => void
  ): () => void {
    const exitHandler = (code: number | null) => {
      Log.debug(`[QwenNotificationMonitor] Process exited with code: ${code}`);
      if (code === 0) {
        Log.info(`✅ Qwen CLI process completed successfully`);
        onComplete();
      } else {
        Log.warn(`⚠️ Qwen CLI process exited with non-zero code: ${code}`);
        onError(new Error(`Qwen CLI exited with code ${code}`));
      }
    };

    const errorHandler = (error: Error) => {
      Log.error(`[QwenNotificationMonitor] Process error: ${error.message}`);
      onError(error);
    };

    process.on("exit", exitHandler);
    process.on("error", errorHandler);

    // Return cleanup function
    return () => {
      process.off("exit", exitHandler);
      process.off("error", errorHandler);
    };
  }
}
