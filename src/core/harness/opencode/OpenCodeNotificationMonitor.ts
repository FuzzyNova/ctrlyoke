import {
  INotificationMonitor,
  HookConfig,
  NotificationMonitorBase,
} from "../shared/interfaces/INotificationMonitor";
import { CliNotificationMonitor } from "../shared/CliNotificationMonitor";
import type { HookEvent, UserHookConfig } from "../../../types/CtrlYokeTypes";

/**
 * OpenCode CLI Notification Monitor
 *
 * Completion detection strategy: OpenCode TypeScript plugin system.
 *
 * OpenCodeCliProvider registers the extension plugin through inline config. The plugin listens for
 * session.created, session.idle, and session.busy events, then writes:
 *
 *   {sessionId}-start.json → on session.created (for early session ID capture)
 *   {sessionId}-stop.json  → on session.idle (for completion detection)
 *
 * These match the standardized two-file format used by Claude and Copilot harnesses,
 * so all monitoring logic is inherited from NotificationMonitorBase unchanged.
 *
 * buildHookConfig() returns type: "none" because plugin registration is done
 * through OpenCode's inline config — not via CLI args.
 */
export class OpenCodeNotificationMonitor
  extends NotificationMonitorBase
  implements INotificationMonitor
{
  /**
   * Build hook configuration.
   *
   * Returns type: "none" — OpenCode completion detection uses an inline plugin,
   * not CLI hook arguments.
   */
  buildHookConfig(
    _scriptPath: string,
    _notifyDir: string,
    _workspaceRoot: string,
    _userHooks?: UserHookConfig[],
    _ctrlyokeEvents?: HookEvent[]
  ): HookConfig {
    return { type: "none" };
  }

  /**
   * Get notification directory for OpenCode
   */
  getNotificationDirectory(workspaceRoot: string): string {
    return CliNotificationMonitor.getNotificationDirectory(
      workspaceRoot,
      "opencode"
    );
  }
}
