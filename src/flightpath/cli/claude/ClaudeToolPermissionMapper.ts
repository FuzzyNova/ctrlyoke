import {
  IToolPermissionMapper,
  ToolPermissionConfig,
  ToolPermissionMapperBase,
} from "../shared/interfaces/IToolPermissionMapper";
import { Log } from "../../../utils/Log";

/**
 * Maps Copilot permission patterns to Claude tool names
 */
const COPILOT_TO_CLAUDE_MAP: Record<string, string> = {
  shell: "Bash",
  write: "Write",
  bash: "Bash",
  read: "Read",
  edit: "Edit",
  multiedit: "MultiEdit",
  glob: "Glob",
  grep: "Grep",
  ls: "LS",
  webfetch: "WebFetch",
  todowrite: "TodoWrite",
};

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
    if (config.mode === "dangerouslyAllowAll") {
      return ["--dangerously-skip-permissions"];
    }

    // Both allowAll and custom modes use --permission-mode bypassPermissions
    const args: string[] = ["--permission-mode", "bypassPermissions"];

    if (config.mode === "allowAll") {
      // Allow all tools (--tools "default") but still apply deny list
      args.push("--tools", "default");
    } else {
      // Custom mode - convert and add specific allow patterns
      const convertedAllowTools: string[] = [];

      config.allowedTools.forEach((tool) => {
        const claudeTool = this.convertToClaudeFormat(tool);
        if (!convertedAllowTools.includes(claudeTool)) {
          convertedAllowTools.push(claudeTool);
        }
      });

      if (convertedAllowTools.length > 0) {
        const quotedTools = convertedAllowTools.map((tool) => `"${tool}"`);
        args.push("--allowedTools", ...quotedTools);
        Log.info(`✅ Allowed tools: ${convertedAllowTools.join(", ")}`);
      }
    }

    // Add deny patterns (for both allowAll and custom modes)
    const convertedDenyTools: string[] = [];

    config.deniedTools.forEach((tool) => {
      const claudeTool = this.convertToClaudeFormat(tool);
      if (!convertedDenyTools.includes(claudeTool)) {
        convertedDenyTools.push(claudeTool);
      }
    });

    if (convertedDenyTools.length > 0) {
      const quotedTools = convertedDenyTools.map((tool) => `"${tool}"`);
      args.push("--disallowedTools", ...quotedTools);
      Log.info(`🚫 Denied tools: ${convertedDenyTools.join(", ")}`);
    }

    return args;
  }

  /**
   * Check if full permissions are granted (no prompts will occur)
   *
   * All modes now auto-grant permissions:
   * - dangerouslyAllowAll: bypasses ALL checks including deny list
   * - allowAll: uses bypassPermissions mode (respects deny list)
   * - custom: uses bypassPermissions mode (respects deny list)
   *
   * @param config Tool permission configuration
   * @returns True (always - all modes auto-grant)
   */
  hasFullPermissions(config: ToolPermissionConfig): boolean {
    return true;
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
