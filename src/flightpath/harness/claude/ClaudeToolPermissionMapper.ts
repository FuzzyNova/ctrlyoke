import {
  IToolPermissionMapper,
  ToolPermissionConfig,
  ToolPermissionMapperBase,
} from "../shared/interfaces/IToolPermissionMapper";
import { COPILOT_TO_CLAUDE_MAP } from "../shared/CliToolPermissionMapper";
import { Log } from "../../../utils/Log";
import { PERMISSION_MODES } from "../../../types/DashboardConstants";

/**
 * Claude CLI Tool Permission Mapper
 *
 * Converts FlightPath's unified tool permission configuration into
 * Claude CLI arguments.
 *
 * Permission modes:
 * - dangerouslyAllowAll: --dangerously-skip-permissions (bypasses ALL checks)
 * - allowAll: --permission-mode bypassPermissions --tools "default" (respects deny list)
 * - custom: --permission-mode bypassPermissions --allowedTools [...] (specific tools + deny list)
 *
 * Tool name conversion:
 * - Copilot format: shell(git:*), write
 * - Claude format: Bash(git:*), Write
 * - Mapping: shell → Bash, write → Write
 * - MCP tools pass through unchanged
 *
 * Claude CLI specifics:
 * - Uses --permission-mode bypassPermissions to auto-grant permissions
 * - Uses --tools "default" for all default tools
 * - Uses --allowedTools for specific tools
 * - Uses --disallowedTools for deny patterns
 * - Tool names are case-sensitive (Bash, Write, not bash, write)
 */
export class ClaudeToolPermissionMapper
  extends ToolPermissionMapperBase
  implements IToolPermissionMapper
{
  /**
   * Build CLI arguments for tool permissions
   *
   * @param config Tool permission configuration
   * @returns CLI arguments array
   */
  buildArgs(config: ToolPermissionConfig): string[] {
    if (config.mode === PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL) {
      return ["--dangerously-skip-permissions"];
    }

    // Both allowAll and custom modes use --permission-mode bypassPermissions
    const args: string[] = ["--permission-mode", "bypassPermissions"];

    if (config.mode === PERMISSION_MODES.ALLOW_ALL) {
      args.push("--tools", "default");
    } else {
      const convertedAllowTools = this.convertUnique(config.allowedTools, (t) =>
        this.convertToClaudeFormat(t)
      );
      if (convertedAllowTools.length > 0) {
        args.push("--allowedTools", ...convertedAllowTools);
        Log.debug(`✅ Allowed tools: ${convertedAllowTools.join(", ")}`);
      }
    }

    const convertedDenyTools = this.convertUnique(config.deniedTools, (t) =>
      this.convertToClaudeFormat(t)
    );
    if (convertedDenyTools.length > 0) {
      args.push("--disallowedTools", ...convertedDenyTools);
      Log.debug(`🚫 Denied tools: ${convertedDenyTools.join(", ")}`);
    }

    return args;
  }

  // ============================================================
  // PRIVATE HELPER METHODS
  // ============================================================

  /**
   * Convert Copilot tool pattern to Claude format
   *
   * Examples:
   * - "shell(git:*)" → "Bash(git:*)"
   * - "write" → "Write"
   * - "github(search)" → "github(search)" (MCP tools pass through)
   *
   * @param copilotPattern Copilot permission pattern
   * @returns Claude tool pattern
   */
  private convertToClaudeFormat(copilotPattern: string): string {
    const parsed = this.parsePattern(copilotPattern);
    if (!parsed) {
      return copilotPattern; // Keep as-is if pattern doesn't match
    }

    const [toolName, toolArgs] = parsed;
    const lowercaseName = toolName.toLowerCase();

    // Look up tool name mapping
    const claudeName = COPILOT_TO_CLAUDE_MAP[lowercaseName];

    if (claudeName) {
      // Convert to Claude format (e.g., shell → Bash)
      return claudeName + toolArgs;
    }

    // MCP tool or unknown - pass through unchanged
    return copilotPattern;
  }
}
