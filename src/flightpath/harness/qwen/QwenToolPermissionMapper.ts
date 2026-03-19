import {
  IToolPermissionMapper,
  ToolPermissionMapperBase,
  ToolPermissionConfig,
} from "../shared/interfaces/IToolPermissionMapper";
import { Log } from "../../../utils/Log";

/**
 * Qwen Code CLI Tool Permission Mapper
 *
 * Converts FlightPath's unified permission configuration to Qwen CLI arguments.
 *
 * **Key Difference:** Qwen uses **mode-based** permissions, not pattern-based like Claude/Copilot.
 *
 * | FlightPath Setting | Qwen Mapping |
 * |-------------------|--------------|
 * | `cliExecutionMode: 'headless'` | No flag (default) |
 * | `cliExecutionMode: 'interactive'` | Terminal TUI (handled by CliIntegration) |
 * | `cliToolPermissions: 'dangerouslyAllowAll'` | `-y` (YOLO mode) |
 * | `cliToolPermissions: 'allowAll'` | `--approval-mode auto-edit` |
 * | `cliToolPermissions: 'custom'` | `--approval-mode default` + tool lists |
 * | `cliAllowedTools: [...]` | `--allowed-tools [...]` |
 * | `cliDeniedTools: [...]` | `--exclude-tools [...]` |
 *
 * Qwen CLI approval modes:
 * - `plan`: Read-only mode, no tool execution
 * - `default`: Prompt for approval before tool execution
 * - `auto-edit`: Auto-approve read/edit operations, prompt for dangerous ops
 * - `yolo`: Auto-approve all tools (use with caution)
 */
export class QwenToolPermissionMapper
  extends ToolPermissionMapperBase
  implements IToolPermissionMapper
{
  /**
   * Build CLI arguments for tool permissions
   *
   * Converts FlightPath permission config to Qwen CLI arguments.
   *
   * @param config Tool permission configuration
   * @returns CLI arguments array
   */
  buildArgs(config: ToolPermissionConfig): string[] {
    const args: string[] = [];

    Log.debug(
      `[QwenPermissionMapper] Building args: mode=${config.mode}, allowed=${config.allowedTools.length}, denied=${config.deniedTools.length}`
    );

    if (config.mode === "dangerouslyAllowAll") {
      // YOLO mode - bypass all approval prompts
      args.push("-y");
      Log.debug("🔓 Qwen YOLO mode enabled (dangerouslyAllowAll)");
    } else if (config.mode === "allowAll") {
      // Auto-approve most operations
      args.push("--approval-mode", "auto-edit");
      Log.debug("✅ Qwen auto-edit mode enabled (allowAll)");
    } else {
      // Custom mode - use default approval with allow/deny lists
      args.push("--approval-mode", "default");
      Log.debug("🔧 Qwen default approval mode (custom)");

      // Add allowed tools if specified
      if (config.allowedTools.length > 0) {
        const allowedArgs = this.convertFlightPathPatternsToQwenTools(
          config.allowedTools
        );
        if (allowedArgs.length > 0) {
          args.push("--allowed-tools", allowedArgs.join(","));
          Log.debug(`📋 Qwen allowed tools: ${allowedArgs.join(", ")}`);
        }
      }

      // Add denied tools if specified (takes precedence over allowed)
      if (config.deniedTools.length > 0) {
        const deniedArgs = this.convertFlightPathPatternsToQwenTools(
          config.deniedTools
        );
        if (deniedArgs.length > 0) {
          args.push("--exclude-tools", deniedArgs.join(","));
          Log.debug(`🚫 Qwen excluded tools: ${deniedArgs.join(", ")}`);
        }
      }
    }

    return args;
  }

  /**
   * Check if full permissions are granted (no prompts will occur)
   *
   * Full permissions in Qwen means:
   * - dangerouslyAllowAll mode (-y flag), OR
   * - allowAll mode (--approval-mode auto-edit)
   *
   * @param config Tool permission configuration
   * @returns True if all permissions auto-granted
   */
  hasFullPermissions(config: ToolPermissionConfig): boolean {
    // YOLO mode bypasses all prompts
    if (config.mode === "dangerouslyAllowAll") {
      return true;
    }

    // Auto-edit mode auto-approves most operations
    if (config.mode === "allowAll") {
      return true;
    }

    // Custom mode may still prompt for approval
    return false;
  }

  /**
   * Convert FlightPath tool patterns to Qwen tool names
   *
   * FlightPath uses patterns like "shell(git:*)" which need to be
   * converted to Qwen's tool name format.
   *
   * Qwen tool names are typically simple identifiers like:
   * - Bash, Write, Read, Edit, Delete
   * - MCP tools: mcp__servername_toolname
   *
   * @param patterns FlightPath tool patterns
   * @returns Qwen tool names array
   */
  private convertFlightPathPatternsToQwenTools(patterns: string[]): string[] {
    const qwenTools: string[] = [];

    for (const pattern of patterns) {
      const parsed = this.parsePattern(pattern);
      if (!parsed) {
        Log.warn(
          `[QwenPermissionMapper] Invalid tool pattern: ${pattern}, skipping`
        );
        continue;
      }

      const [toolName, toolArgs] = parsed;
      const normalizedToolName = toolName.toLowerCase();

      // Map FlightPath tool names to Qwen equivalents
      if (normalizedToolName === "shell" || normalizedToolName === "bash") {
        qwenTools.push("Bash");
      } else if (normalizedToolName === "write" || normalizedToolName === "create") {
        qwenTools.push("Write");
      } else if (normalizedToolName === "read") {
        qwenTools.push("Read");
      } else if (normalizedToolName === "edit" || normalizedToolName === "str_replace") {
        qwenTools.push("Edit");
      } else if (normalizedToolName === "delete" || normalizedToolName === "remove") {
        qwenTools.push("Delete");
      } else if (normalizedToolName === "web_search" || normalizedToolName === "search") {
        qwenTools.push("WebSearch");
      } else if (normalizedToolName === "mcp") {
        // MCP tools: preserve full pattern for server matching
        if (toolArgs) {
          qwenTools.push(`mcp__${toolArgs.replace(/[()]/g, "")}`);
        }
      } else {
        // Unknown tool - pass through as-is
        qwenTools.push(toolName);
      }
    }

    return qwenTools;
  }
}
