import {
  IToolPermissionMapper,
  ToolPermissionConfig,
} from "../shared/interfaces/IToolPermissionMapper";
import { Log } from "../../../utils/Log";

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
 * - dangerouslyAllowAll: --allow-all-tools (ignores deny list)
 * - allowAll: --allow-all-tools + --deny-tool patterns
 * - custom: --allow-tool patterns + --deny-tool patterns
 *
 * Read-only tools (always allowed, no CLI args needed):
 * - grep, list_files, read, read_file, etc.
 */
export class CopilotToolPermissionMapper implements IToolPermissionMapper {
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
    if (config.mode === "dangerouslyAllowAll" || config.mode === "allowAll") {
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
        Log.info(`✅ Allowed tools: ${convertedAllowTools.join(", ")}`);
      }
    }

    // Add denied tool patterns (unless dangerouslyAllowAll mode)
    if (config.mode !== "dangerouslyAllowAll") {
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
        Log.info(`🚫 Denied tools: ${convertedDenyTools.join(", ")}`);
      }
    }

    // Log filtered tools for visibility
    if (filteredTools.length > 0) {
      Log.info(
        `ℹ️ Filtered out tools not requiring Copilot permission: ${filteredTools.join(", ")} (read-only operations are always allowed)`
      );
    }

    return args;
  }

  /**
   * Check if full permissions are granted (no interactive prompts will occur)
   *
   * Full permissions require:
   * - allowAll mode (or dangerouslyAllowAll)
   * - No deny patterns
   *
   * @param config Tool permission configuration
   * @returns True if all permissions auto-granted
   */
  hasFullPermissions(config: ToolPermissionConfig): boolean {
    // Full permissions only if allowAll mode and no deny patterns
    return (
      (config.mode === "allowAll" || config.mode === "dangerouslyAllowAll") &&
      config.deniedTools.length === 0
    );
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

  /**
   * Parse a tool pattern into name and arguments
   *
   * @param pattern Tool pattern string (e.g., "shell(git:*)")
   * @returns [toolName, args] or null if invalid
   *
   * @example
   * parsePattern("shell(git:*)") → ["shell", "(git:*)"]
   * parsePattern("write") → ["write", ""]
   * parsePattern("invalid-pattern!") → null
   */
  private parsePattern(pattern: string): [string, string] | null {
    const match = pattern.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)(\(.*\))?$/);
    if (!match) {
      return null;
    }
    return [match[1], match[2] || ""];
  }
}
