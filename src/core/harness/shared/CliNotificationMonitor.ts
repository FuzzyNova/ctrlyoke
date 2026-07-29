import * as path from "path";
import { PATH_CONSTANTS } from "../../../utils/ConfigurationUtils";

/**
 * Shared hook/notification file monitoring utilities
 *
 * Used by CLI integrations that support hooks for completion detection:
 * - Copilot CLI: sessionEnd hook (writes session-{id}.json when session completes)
 * - Claude CLI: Stop hook (writes session-{id}.json when agent stops)
 * - Codex CLI: Notify hook (writes thread-{id}.json on agent-turn-complete)
 */
export class CliNotificationMonitor {
  /**
   * Get workspace-specific notification directory
   *
   * Uses pattern: {workspace}/.ctrlyoke/temp/{cli}-notifications/
   * This prevents conflicts when multiple VS Code instances run ctrlyoke.
   *
   * @param workspaceRoot Workspace root directory
   * @param cliName CLI name (e.g., "claude", "codex")
   * @returns Notification directory path
   */
  static getNotificationDirectory(
    workspaceRoot: string,
    cliName: string
  ): string {
    return path.join(
      workspaceRoot,
      PATH_CONSTANTS.CTRLYOKE_DIR,
      PATH_CONSTANTS.TEMP_DIR,
      `${cliName}-notifications`
    );
  }

  /**
   * Normalize paths to forward slashes and build a `node <script> <dir>` command.
   *
   * @param scriptPath Path to the notification hook script
   * @param notifyDir Notification directory path
   * @param quoted Whether to wrap paths in double-quotes (default true).
   *   Pass false for harnesses whose hook runners parse the command via spawn
   *   with shell: false — quotes would become literal characters in argv.
   * @returns Ready-to-use node command string
   */
  static buildNodeCommand(
    scriptPath: string,
    notifyDir: string,
    quoted = true
  ): string {
    const s = scriptPath.replace(/\\/g, "/");
    const d = notifyDir.replace(/\\/g, "/");
    return quoted ? `node "${s}" "${d}"` : `node ${s} ${d}`;
  }

  // Harness-specific hook config builders moved to:
  // - CopilotNotificationMonitor.buildCopilotHookConfig()
  // - ClaudeNotificationMonitor.buildClaudeStopHookSettings()
  // - CodexNotificationMonitor.buildCodexNotifyConfig()
}
