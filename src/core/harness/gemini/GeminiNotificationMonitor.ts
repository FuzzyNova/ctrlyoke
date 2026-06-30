import {
  INotificationMonitor,
  HookConfig,
  NotificationMonitorBase,
} from "../shared/interfaces/INotificationMonitor";
import { CliNotificationMonitor } from "../shared/CliNotificationMonitor";
import type { HookEvent, UserHookConfig } from "../../../types/FlightPathTypes";

/**
 * Gemini CLI Notification Monitor
 *
 * Hook configuration: Written to .gemini/settings.json in workspace (no --settings flag).
 * Notification directory: .flightpath/temp/gemini-notifications/
 * Notification script: flightpath-gemini-hook.js
 *
 * Gemini uses AfterAgent (not Stop) as the completion event.
 * The hook script normalizes AfterAgent → hookEvent: "Stop" so
 * NotificationMonitorBase.monitorForCompletion() works unchanged.
 *
 * All monitoring logic (waitForSessionStart, monitorForCompletion,
 * cleanupNotificationFiles, extractSessionId) is inherited from NotificationMonitorBase.
 */
export class GeminiNotificationMonitor
  extends NotificationMonitorBase
  implements INotificationMonitor
{
  static readonly EVENT_MAP: Partial<Record<HookEvent, string>> = {
    stop: "AfterAgent",
    sessionStart: "SessionStart",
    preToolUse: "BeforeTool",
    postToolUse: "AfterTool",
    userPromptSubmit: "BeforeAgent",
    // Gemini surfaces tool permission alerts through the Notification hook.
    permissionRequest: "Notification",
  };

  /**
   * Build hook configuration for Gemini CLI.
   *
   * Returns a JSON object that GeminiCliProvider merges into .gemini/settings.json.
   * Uses SessionStart + AfterAgent (Gemini's completion event).
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
    const encodedDecisionHook = this.encodePermissionRequestHook(userHooks);
    const hooks = this.buildCommandHooks(
      command,
      GeminiNotificationMonitor.EVENT_MAP,
      selectedEvents,
      userHooks,
      encodedDecisionHook
    );
    return { type: "json", config: { hooks } };
  }

  getNotificationDirectory(workspaceRoot: string): string {
    return CliNotificationMonitor.getNotificationDirectory(
      workspaceRoot,
      "gemini"
    );
  }
}
