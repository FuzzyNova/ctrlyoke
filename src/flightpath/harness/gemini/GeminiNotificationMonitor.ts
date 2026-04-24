import {
  INotificationMonitor,
  HookConfig,
  NotificationMonitorBase,
} from "../shared/interfaces/INotificationMonitor";
import { CliNotificationMonitor } from "../shared/CliNotificationMonitor";
import type { UserHookConfig } from "../../../types/FlightPathTypes";

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
    userHooks?: UserHookConfig[]
  ): HookConfig {
    const command = CliNotificationMonitor.buildNodeCommand(scriptPath, notifyDir);
    const flightpathEntry = { hooks: [{ type: "command", command }] };

    // Map logical event names to Gemini's native event names
    const eventMap: Record<string, string> = {
      stop: "AfterAgent",
      sessionStart: "SessionStart",
      preToolUse: "BeforeTool",
      postToolUse: "AfterTool",
      userPromptSubmit: "BeforeAgent",
    };

    // Build hooks object starting with FlightPath's entries
    const hooks: Record<string, unknown[]> = {
      SessionStart: [flightpathEntry],
      AfterAgent: [flightpathEntry],
    };

    // Append user hooks to their respective events
    if (userHooks) {
      for (const uh of userHooks) {
        const nativeEvent = eventMap[uh.event];
        if (!nativeEvent) continue; // Skip unsupported events
        if (!hooks[nativeEvent]) hooks[nativeEvent] = [];
        hooks[nativeEvent].push({
          hooks: [{ type: "command", command: uh.command }],
        });
      }
    }

    return {
      type: "json",
      config: { hooks },
    };
  }

  getNotificationDirectory(workspaceRoot: string): string {
    return CliNotificationMonitor.getNotificationDirectory(workspaceRoot, "gemini");
  }
}
