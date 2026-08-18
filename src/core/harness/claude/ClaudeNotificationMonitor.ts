import {
  INotificationMonitor,
  HookConfig,
  NotificationMonitorBase,
} from "../shared/interfaces/INotificationMonitor";
import { CliNotificationMonitor } from "../shared/CliNotificationMonitor";
import type { HookEvent, UserHookConfig } from "../../../types/CtrlYokeTypes";
import type { CapabilityDeclaration } from "../../../types/CompatibilityTypes";
import {
  CAPABILITY_FIDELITIES,
  CAPABILITY_MECHANISMS,
} from "../../../types/DashboardConstants";

/**
 * Claude CLI Notification Monitor
 *
 * Hook configuration: JSON string passed via --settings flag
 * Notification directory: .ctrlyoke/temp/claude-notifications/
 * Notification script: ctrlyoke-claude-hook.js
 *
 * Notification file format (standardized with Copilot):
 *   {sessionId}-start.json → { hookEvent: "SessionStart", sessionId, status: "started" }
 *   {sessionId}-stop.json  → { hookEvent: "Stop", sessionId, status: "completed" }
 *
 * All monitoring logic (waitForSessionStart, monitorForCompletion,
 * cleanupNotificationFiles, extractSessionId) is inherited from NotificationMonitorBase.
 */
export class ClaudeNotificationMonitor
  extends NotificationMonitorBase
  implements INotificationMonitor
{
  /** Map logical event names to Claude's native event names. */
  static readonly EVENT_MAP: Record<HookEvent, string> = {
    stop: "Stop",
    error: "StopFailure",
    sessionStart: "SessionStart",
    preToolUse: "PreToolUse",
    postToolUse: "PostToolUse",
    userPromptSubmit: "UserPromptSubmit",
    // Decision hook: Claude pipes the payload on stdin and reads stdout as the
    // allow/deny decision. Registered as a direct hook entry — not via the
    // ctrlyoke notification script — so Claude handles the stdin/stdout
    // contract natively without ctrlyoke interception.
    permissionRequest: "PermissionRequest",
  };

  static readonly CAPABILITIES: Record<HookEvent, CapabilityDeclaration> =
    Object.fromEntries(
      Object.keys(ClaudeNotificationMonitor.EVENT_MAP).map((event) => [
        event,
        {
          fidelity: CAPABILITY_FIDELITIES.EXACT,
          mechanism: CAPABILITY_MECHANISMS.WORKSPACE_CONFIG,
          verification: {
            kind: "manual",
            reference: "src/core/harness/claude/ClaudeNotificationMonitor.ts",
            basis: "cli-version",
            verifiedVersions: [">=2.0.76"],
          },
        },
      ])
    ) as unknown as Record<HookEvent, CapabilityDeclaration>;

  /**
   * Build a user-hooks-only Claude settings JSON string (no ctrlyoke notification entries).
   * Used for headless mode where completion detection is process-exit based.
   */
  static buildUserOnlyConfig(userHooks: UserHookConfig[]): string {
    const hooks: Record<string, unknown[]> = {};
    for (const uh of userHooks) {
      const nativeEvent = ClaudeNotificationMonitor.EVENT_MAP[uh.event];
      if (!nativeEvent) continue;
      if (!hooks[nativeEvent]) hooks[nativeEvent] = [];
      hooks[nativeEvent].push({
        hooks: [{ type: "command", command: uh.command }],
      });
    }
    return JSON.stringify({ hooks });
  }

  /**
   * Build hook configuration for Claude CLI
   *
   * Claude uses JSON string (not object) for --settings flag.
   * Configures both SessionStart and Stop hooks.
   *
   * @param scriptPath Path to notification handler script (ctrlyoke-claude-hook.js)
   * @param notifyDir Notification directory
   * @param workspaceRoot Workspace root directory (unused for Claude)
   * @returns Hook configuration as JSON string
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
    const selectedEvents = ctrlyokeEvents ?? ["sessionStart", "stop", "error"];
    const encodedDecisionHook = this.encodePermissionRequestHook(userHooks);
    const hooks = this.buildCommandHooks(
      command,
      ClaudeNotificationMonitor.EVENT_MAP,
      selectedEvents,
      userHooks,
      encodedDecisionHook
    );
    return { type: "json-string", config: JSON.stringify({ hooks }) };
  }

  /**
   * Get notification directory for Claude CLI
   *
   * @param workspaceRoot Workspace root
   * @returns Notification directory path
   */
  getNotificationDirectory(workspaceRoot: string): string {
    return CliNotificationMonitor.getNotificationDirectory(
      workspaceRoot,
      "claude"
    );
  }
}
