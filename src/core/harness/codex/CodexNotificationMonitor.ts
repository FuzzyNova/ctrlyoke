import {
  INotificationMonitor,
  HookConfig,
  NotificationMonitorBase,
} from "../shared/interfaces/INotificationMonitor";
import { createCodexCommandHookGroup } from "../shared/CodexHookUtils";
import { CliNotificationMonitor } from "../shared/CliNotificationMonitor";
import type { HookEvent, UserHookConfig } from "../../../types/CtrlYokeTypes";

/**
 * Codex CLI Notification Monitor
 *
 * Hook configuration: emitted as inline `-c hooks.<Event>=[…]` CLI overrides by
 * CodexInlineHooksBuilder. ctrlyoke writes no hook file into the workspace.
 * Requires --enable hooks flag to activate the hook system.
 * Notification directory: .ctrlyoke/temp/codex-notifications/
 * Notification script: ctrlyoke-codex-notify.js
 *
 * Codex hooks use a matcher-based format (unlike Claude/Qwen which omit matcher):
 *   { matcher: "", hooks: [{ type: "command", command: "..." }] }
 *
 * Notification file format (standardized with Claude/Qwen/Antigravity):
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
   * Returns a JSON object that CodexCliProvider serializes into inline `-c`
   * overrides via CodexInlineHooksBuilder.
   * Uses Codex's matcher-based format: { matcher: "", hooks: [{...}] }
   * Registers SessionStart and Stop for ctrlyoke's completion detection.
   *
   * User hooks (from the workflow `hooks:` property) are handled by
   * CodexCliProvider via SettingsJsonHooksTracker — not here. The
   * _userHooks parameter is intentionally unused (mirrors Qwen pattern).
   */
  buildHookConfig(
    scriptPath: string,
    notifyDir: string,
    _workspaceRoot: string,
    userHooks?: UserHookConfig[],
    ctrlyokeEvents?: HookEvent[]
  ): HookConfig {
    const command = CliNotificationMonitor.buildNodeCommand(
      scriptPath,
      notifyDir
    );
    const selectedEvents = ctrlyokeEvents ?? ["sessionStart", "stop"];
    const eventMap: Partial<Record<HookEvent, string>> = {
      stop: "Stop",
      sessionStart: "SessionStart",
      preToolUse: "PreToolUse",
      postToolUse: "PostToolUse",
      userPromptSubmit: "UserPromptSubmit",
      permissionRequest: "PermissionRequest",
    };
    const encodedDecisionHook = this.encodePermissionRequestHook(userHooks);
    const hooks = this.buildCommandHooks(
      command,
      eventMap,
      selectedEvents,
      undefined, // user hooks are merged by CodexCliProvider via SettingsJsonHooksTracker, not here
      encodedDecisionHook,
      createCodexCommandHookGroup
    );

    return {
      type: "json",
      config: { hooks },
    };
  }

  /**
   * Get notification directory for Codex CLI.
   * Uses shared pattern: {workspace}/.ctrlyoke/temp/codex-notifications/
   */
  getNotificationDirectory(workspaceRoot: string): string {
    return CliNotificationMonitor.getNotificationDirectory(
      workspaceRoot,
      "codex"
    );
  }
}
