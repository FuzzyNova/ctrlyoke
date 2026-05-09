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
    const flightpathEntry = { hooks: [{ type: "command", command }] };

    // Map logical event names to Gemini's native event names
    const eventMap: Partial<Record<HookEvent, string>> = {
      stop: "AfterAgent",
      sessionStart: "SessionStart",
      preToolUse: "BeforeTool",
      postToolUse: "AfterTool",
      userPromptSubmit: "BeforeAgent",
    };

    const hooks: Record<string, unknown[]> = {};
    for (const event of flightpathEvents ?? ["sessionStart", "stop"]) {
      const nativeEvent = eventMap[event];
      if (!nativeEvent) {
        continue;
      }
      hooks[nativeEvent] = [flightpathEntry];
    }

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
    return CliNotificationMonitor.getNotificationDirectory(
      workspaceRoot,
      "gemini"
    );
  }
}
