import {
  INotificationMonitor,
  HookConfig,
  NotificationMonitorBase,
} from "../shared/interfaces/INotificationMonitor";
import { CliNotificationMonitor } from "../shared/CliNotificationMonitor";
import type { HookEvent, UserHookConfig } from "../../../types/CtrlYokeTypes";

/**
 * Qwen Code CLI Notification Monitor
 *
 * Hook configuration: Written to .qwen/settings.json in workspace (no --settings flag).
 * Requires --experimental-hooks CLI flag to activate the hook system.
 * Notification directory: .ctrlyoke/temp/qwen-notifications/
 * Notification script: ctrlyoke-qwen-hook.js
 *
 * Qwen Code is a Claude fork — uses the same hook event names (SessionStart + Stop)
 * and the same two-file notification format.
 *
 * All monitoring logic (waitForSessionStart, monitorForCompletion,
 * cleanupNotificationFiles, extractSessionId) is inherited from NotificationMonitorBase.
 */
export class QwenNotificationMonitor
  extends NotificationMonitorBase
  implements INotificationMonitor
{
  static readonly EVENT_MAP: Partial<Record<HookEvent, string>> = {
    stop: "Stop",
    sessionStart: "SessionStart",
    preToolUse: "PreToolUse",
    postToolUse: "PostToolUse",
    userPromptSubmit: "UserPromptSubmit",
    permissionRequest: "PermissionRequest",
  };

  /**
   * Qwen's reliable session-start signal is UserPromptSubmit, not SessionStart.
   * SessionStart fires fire-and-forget in AppContainer's useEffect and may not
   * complete before the session ends on fast prompts launched via `-i`.
   */
  protected override getStartHookEvents(): string[] {
    return ["SessionStart", "UserPromptSubmit"];
  }

  /**
   * Build hook configuration for Qwen Code CLI.
   *
   * Returns a JSON object that QwenCliProvider merges into .qwen/settings.json.
   * Registers SessionStart, UserPromptSubmit, and Stop.
   * UserPromptSubmit is the reliable start signal (SessionStart may not fire on
   * fast `-i` prompts due to fire-and-forget useEffect timing in AppContainer).
   */
  buildHookConfig(
    scriptPath: string,
    notifyDir: string,
    _workspaceRoot: string,
    userHooks?: UserHookConfig[],
    ctrlyokeEvents?: HookEvent[]
  ): HookConfig {
    // No quotes: Qwen's hook runner calls spawn(cmd.exe, ['/d','/s','/c', command], {shell:false}).
    // Node.js Windows arg escaping converts any `"` in the command to `\"`, which cmd.exe then
    // passes literally to the child process — the quote becomes part of argv[1], making Node.js
    // treat the absolute path as relative. Forward-slash absolute paths work without quotes on
    // Windows as long as they contain no spaces. Paths with spaces are a known limitation.
    const command = CliNotificationMonitor.buildNodeCommand(
      scriptPath,
      notifyDir,
      false
    );
    const encodedDecisionHook = this.encodePermissionRequestHook(userHooks);

    const hooks: Record<string, unknown[]> = {};
    for (const event of ctrlyokeEvents ?? [
      "sessionStart",
      "userPromptSubmit",
      "stop",
    ]) {
      const nativeEvent = QwenNotificationMonitor.EVENT_MAP[event];
      if (!nativeEvent) {
        continue;
      }
      const eventCommand =
        event === "permissionRequest" && encodedDecisionHook
          ? `${command} ${encodedDecisionHook}`
          : command;
      hooks[nativeEvent] = [
        { hooks: [{ type: "command", command: eventCommand }] },
      ];
    }

    return {
      type: "json",
      config: { hooks },
    };
  }

  /**
   * Get notification directory for Qwen Code CLI.
   * Uses shared pattern: {workspace}/.ctrlyoke/temp/qwen-notifications/
   */
  getNotificationDirectory(workspaceRoot: string): string {
    return CliNotificationMonitor.getNotificationDirectory(
      workspaceRoot,
      "qwen"
    );
  }
}
