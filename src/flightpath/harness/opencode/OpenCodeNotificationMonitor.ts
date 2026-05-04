import {
  INotificationMonitor,
  HookConfig,
  NotificationMonitorBase,
} from "../shared/interfaces/INotificationMonitor";
import { CliNotificationMonitor } from "../shared/CliNotificationMonitor";
import type {
  HookEvent,
  UserHookConfig,
} from "../../../types/FlightPathTypes";

/**
 * OpenCode CLI Notification Monitor
 *
 * Completion detection strategy: OpenCode TypeScript plugin system.
 *
 * Before the TUI launches, OpenCodeCliProvider writes a CommonJS plugin to
 * .opencode/plugin/flightpath-completion-hook.ts. The plugin listens for
 * session.created, session.idle, and session.busy events, then writes:
 *
 *   {sessionId}-start.json → on session.created (for early session ID capture)
 *   {sessionId}-stop.json  → on session.idle (for completion detection)
 *
 * These match the standardized two-file format used by Claude and Copilot harnesses,
 * so all monitoring logic is inherited from NotificationMonitorBase unchanged.
 *
 * buildHookConfig() returns type: "none" because plugin file management is done
 * as a side effect in OpenCodeCliProvider.buildCliArgs() — not via CLI args.
 *
 * getPluginContent(notifyDir) is an opencode-specific method called directly
 * by OpenCodeCliProvider to get the plugin JS content to write to disk.
 */
export class OpenCodeNotificationMonitor
  extends NotificationMonitorBase
  implements INotificationMonitor
{
  /**
   * Build hook configuration.
   *
   * Returns type: "none" — OpenCode completion detection uses a plugin file
   * written to .opencode/plugin/ before execution, not CLI arguments.
   */
  buildHookConfig(
    _scriptPath: string,
    _notifyDir: string,
    _workspaceRoot: string,
    _userHooks?: UserHookConfig[],
    _flightpathEvents?: HookEvent[]
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
