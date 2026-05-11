import {
  INotificationMonitor,
  HookConfig,
  NotificationMonitorBase,
} from "../shared/interfaces/INotificationMonitor";
import { createCodexCommandHookGroup } from "../shared/CodexHookUtils";
import { CliNotificationMonitor } from "../shared/CliNotificationMonitor";
import type { HookEvent, UserHookConfig } from "../../../types/FlightPathTypes";

/**
 * Codex CLI Notification Monitor
 *
 * Hook configuration: Written to .codex/hooks.json in workspace.
 * Requires --enable hooks flag to activate the hook system.
 * Notification directory: .flightpath/temp/codex-notifications/
 * Notification script: flightpath-codex-notify.js
 *
 * Codex hooks use a matcher-based format (unlike Claude/Qwen which omit matcher):
 *   { matcher: "", hooks: [{ type: "command", command: "..." }] }
 *
 * Notification file format (standardized with Claude/Qwen/Gemini):
 *   {sessionId}-start.json → { hookEvent: "SessionStart", sessionId, status: "started" }
 *   {sessionId}-stop.json  → { hookEvent: "Stop", sessionId, status: "completed" }
 *
 * All monitoring logic (waitForSessionStart, monitorForCompletion,
 * cleanupNotificationFiles, extractSessionId) is inherited from NotificationMonitorBase.
 *
 * Hook events supported (via --enable hooks):
 *   SessionStart, PreToolUse, PostToolUse, UserPromptSubmit, Stop
 *
 * | Logical event      | Codex native event |
 * |--------------------|--------------------|
 * | stop               | Stop               |
 * | sessionStart       | SessionStart       |
 * | preToolUse         | PreToolUse         |
 * | postToolUse        | PostToolUse        |
 * | userPromptSubmit   | UserPromptSubmit   |
 */
export class CodexNotificationMonitor
  extends NotificationMonitorBase
  implements INotificationMonitor
{
  /**
   * Build hook configuration for Codex CLI.
   *
   * Returns a JSON object that CodexCliProvider writes to .codex/hooks.json.
   * Uses Codex's matcher-based format: { matcher: "", hooks: [{...}] }
   * Registers SessionStart and Stop for FlightPath's completion detection.
   *
   * User hooks (from the workflow `hooks:` property) are handled by
   * CodexCliProvider via SettingsJsonHooksTracker — not here. The
   * _userHooks parameter is intentionally unused (mirrors Qwen/Gemini pattern).
   */
  buildHookConfig(
    scriptPath: string,
    notifyDir: string,
    _workspaceRoot: string,
    userHooks?: UserHookConfig[],
    flightpathEvents?: HookEvent[]
  ): HookConfig {
    const command = CliNotificationMonitor.buildNodeCommand(
      scriptPath,
      notifyDir
    );
    const selectedEvents = flightpathEvents ?? ["sessionStart", "stop"];
    const eventMap: Record<HookEvent, string> = {
      stop: "Stop",
      sessionStart: "SessionStart",
      preToolUse: "PreToolUse",
      postToolUse: "PostToolUse",
      userPromptSubmit: "UserPromptSubmit",
      permissionRequest: "PermissionRequest",
    };
    const permissionRequestHook = userHooks?.find(
      (hook) => hook.event === "permissionRequest"
    );
    const encodedDecisionHook = permissionRequestHook
      ? Buffer.from(permissionRequestHook.command, "utf8").toString("base64")
      : undefined;

    const hooks: Record<string, unknown[]> = {};
    for (const event of selectedEvents) {
      const nativeEvent = eventMap[event];
      const eventCommand =
        event === "permissionRequest" && encodedDecisionHook
          ? `${command} "${encodedDecisionHook}"`
          : command;
      hooks[nativeEvent] = [
        createCodexCommandHookGroup(nativeEvent, eventCommand),
      ];
    }

    return {
      type: "json",
      config: { hooks },
    };
  }

  /**
   * Get notification directory for Codex CLI.
   * Uses shared pattern: {workspace}/.flightpath/temp/codex-notifications/
   */
  getNotificationDirectory(workspaceRoot: string): string {
    return CliNotificationMonitor.getNotificationDirectory(
      workspaceRoot,
      "codex"
    );
  }
}
