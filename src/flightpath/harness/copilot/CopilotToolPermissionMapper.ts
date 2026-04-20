import {
  IToolPermissionMapper,
  ToolPermissionConfig,
  ToolPermissionMapperBase,
} from "../shared/interfaces/IToolPermissionMapper";
import { Log } from "../../../utils/Log";
import { PERMISSION_MODES } from "../../../types/DashboardConstants";

/**
 * Copilot CLI Tool Permission Mapper
 *
 * Converts FlightPath's unified tool permission configuration into Copilot CLI arguments.
 *
 * Tool pattern format (user-friendly):
 * - shell(git:*) - Shell commands matching pattern
 * - write - File write operations
 * - <mcp-server>(tool) - MCP server tools
 *
 * CLI arguments:
 * - --allow-all-tools: Grant all tools
 * - --allow-tool "pattern": Grant specific tool
 * - --deny-tool "pattern": Deny specific tool (takes precedence)
 *
 * Permission modes:
 * - dangerouslyAllowAll: --yolo (bypasses all restrictions, ignores deny list)
 * - allowAll: --allow-all-tools + --deny-tool patterns
 * - custom: --allow-tool patterns + --deny-tool patterns
 *
 * Read-only tools (always allowed, no CLI args needed):
 * - grep, list_files, read, read_file, etc.
 */
export class CopilotToolPermissionMapper
  extends ToolPermissionMapperBase
  implements IToolPermissionMapper
{
  /**
   * Read-only tools that don't require explicit permission
   * (Copilot CLI auto-grants these)
   */
  private readonly READ_ONLY_TOOLS = [
    "grep",
    "list_files",
    "read",
    "read_file",
    "search_files",
  ];

  /**
   * Build Copilot CLI permission arguments
   *
   * @param config Tool permission configuration
   * @returns CLI arguments array
   */
  buildArgs(config: ToolPermissionConfig): string[] {
    const args: string[] = [];
    const filteredTools: string[] = [];

    // Add allow mode first
    if (config.mode === PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL) {
      args.push("--yolo");
    } else if (config.mode === PERMISSION_MODES.ALLOW_ALL) {
      args.push("--allow-all-tools");
    } else {
      // Custom mode - convert and add specific allow patterns
      const convertedAllowTools: string[] = [];

      config.allowedTools.forEach((tool) => {
        const converted = this.convertToCopilotFormat(tool);
        if (converted === null) {
          filteredTools.push(tool);
        } else if (!convertedAllowTools.includes(converted)) {
          convertedAllowTools.push(converted);
        }
      });

      if (convertedAllowTools.length > 0) {
        const quotedTools = convertedAllowTools.map((tool) => `"${tool}"`);
        args.push("--allow-tool", ...quotedTools);
        Log.debug(`✅ Allowed tools: ${convertedAllowTools.join(", ")}`);
      }
    }

    // Add denied tool patterns (unless dangerouslyAllowAll mode)
    if (config.mode !== PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL) {
      const convertedDenyTools: string[] = [];

      config.deniedTools.forEach((tool) => {
        const converted = this.convertToCopilotFormat(tool);
        if (converted === null) {
          filteredTools.push(tool);
        } else if (!convertedDenyTools.includes(converted)) {
          convertedDenyTools.push(converted);
        }
      });

      if (convertedDenyTools.length > 0) {
        const quotedTools = convertedDenyTools.map((tool) => `"${tool}"`);
        args.push("--deny-tool", ...quotedTools);
        Log.debug(`🚫 Denied tools: ${convertedDenyTools.join(", ")}`);
      }
    }

    // Log filtered tools for visibility
    if (filteredTools.length > 0) {
      Log.debug(
        `ℹ️ Filtered out tools not requiring Copilot permission: ${filteredTools.join(", ")} (read-only operations are always allowed)`
      );
    }

    return args;
  }

  /**
   * Convert tool pattern to Copilot CLI format
   *
   * Filters out read-only tools (always allowed, no args needed).
   * Passes through other patterns as-is (Copilot uses same format as user config).
   *
   * @param pattern Tool pattern from user config
   * @returns Converted pattern, or null if should be filtered
   */
  private convertToCopilotFormat(pattern: string): string | null {
    // Parse pattern to extract tool name
    const parsed = this.parsePattern(pattern);
    if (!parsed) {
      Log.warn(`⚠️ Invalid tool pattern: ${pattern}`);
      return null;
    }

    const [toolName] = parsed;

    // Filter read-only tools (auto-granted by Copilot)
    if (this.READ_ONLY_TOOLS.includes(toolName.toLowerCase())) {
      return null;
    }

    // Copilot uses same pattern format as user config
    return pattern;
  }
}
