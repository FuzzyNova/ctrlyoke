import {
  IToolPermissionMapper,
  PermissionContext,
  ToolPermissionConfig,
  ToolPermissionMapperBase,
  ToolPermissionApplication,
} from "../shared/interfaces/IToolPermissionMapper";
import type { PermissionCapabilityDescriptor } from "../../../types/CompatibilityTypes";
import { Log } from "../../../utils/Log";
import {
  HARNESS_IDS,
  PERMISSION_MODES,
} from "../../../types/DashboardConstants";

const COPILOT_PERMISSION_VERIFICATION = {
  kind: "manual",
  reference:
    "dev/implemented/PERMISSIONS_PER_WORKFLOW_PLAN.md#actual-flag-mapping",
  basis: "cli-version",
  verifiedVersions: [">=0.0.384"],
} as const;

const COPILOT_PERMISSION_CAPABILITIES: PermissionCapabilityDescriptor = {
  mode: {
    fidelity: "exact",
    mechanism: "native",
    verification: COPILOT_PERMISSION_VERIFICATION,
  },
  allowedTools: {
    fidelity: "exact",
    mechanism: "native",
    verification: COPILOT_PERMISSION_VERIFICATION,
  },
  deniedTools: {
    fidelity: "exact",
    mechanism: "native",
    verification: COPILOT_PERMISSION_VERIFICATION,
  },
};

/** Copilot's built-in permission kinds cannot be used as MCP server IDs. */
const COPILOT_BUILT_IN_PERMISSION_KINDS = new Set([
  "memory",
  "read",
  "shell",
  "url",
  "write",
]);

const COPILOT_READ_ONLY_TOOLS: readonly string[] = [
  "grep",
  "list_files",
  "read",
  "read_file",
  "search_files",
] as const;

/**
 * Copilot CLI Tool Permission Mapper
 *
 * Converts ctrlyoke's unified tool permission configuration into Copilot CLI arguments.
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
  readonly capabilities = COPILOT_PERMISSION_CAPABILITIES;

  static isSafeMcpServerId(serverId: string): boolean {
    return (
      !COPILOT_BUILT_IN_PERMISSION_KINDS.has(serverId.toLowerCase()) &&
      !/[(),\s]/.test(serverId)
    );
  }

  static toCopilotMcpToolPattern(
    serverId: string,
    tool: string
  ): string | null {
    if (!this.isSafeMcpServerId(serverId) || /[(),]/.test(tool)) {
      return null;
    }
    return `${serverId}(${tool})`;
  }

  /**
   * Read-only tools that don't require explicit permission
   * (Copilot CLI auto-grants these)
   */
  private readonly READ_ONLY_TOOLS = COPILOT_READ_ONLY_TOOLS;

  /**
   * Build Copilot CLI permission arguments
   *
   * @param config Tool permission configuration
   * @returns CLI arguments array
   */
  async prepare(
    config: ToolPermissionConfig,
    _context: PermissionContext
  ): Promise<ToolPermissionApplication> {
    if (config.mode === PERMISSION_MODES.NONE) {
      return { cliArgs: [], diagnostics: [] };
    }
    const args: string[] = [];
    const filteredTools: string[] = [];

    if (config.mode === PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL) {
      args.push("--yolo");
    } else if (config.mode === PERMISSION_MODES.ALLOW_ALL) {
      args.push("--allow-all-tools");
    } else {
      const convertedAllowTools = this.convertUnique(
        config.allowedTools,
        (t) => this.convertToCopilotFormat(t),
        filteredTools
      );
      if (convertedAllowTools.length > 0) {
        args.push("--allow-tool", ...convertedAllowTools);
        Log.debug(
          `[CopilotToolPermissionMapper] Allowed tools: ${convertedAllowTools.join(", ")}`
        );
      }
    }

    if (config.mode !== PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL) {
      const convertedDenyTools = this.convertUnique(
        config.deniedTools,
        (t) => this.convertToCopilotFormat(t),
        filteredTools
      );
      if (convertedDenyTools.length > 0) {
        args.push("--deny-tool", ...convertedDenyTools);
        Log.debug(
          `[CopilotToolPermissionMapper] Denied tools: ${convertedDenyTools.join(", ")}`
        );
      }
    }

    if (filteredTools.length > 0) {
      Log.debug(
        `[CopilotToolPermissionMapper] Filtered out tools not requiring Copilot permission: ${filteredTools.join(", ")} (read-only operations are always allowed)`
      );
    }

    return {
      cliArgs: args,
      diagnostics: this.getToolTranslationDiagnostics(
        config,
        HARNESS_IDS.COPILOT_CLI
      ),
    };
  }

  /**
   * Convert tool pattern to Copilot CLI format
   *
   * Handles three input forms:
   * - Claude-format MCP: `mcp__serverid__toolname` → `serverid(toolname)`
   * - Copilot-format MCP: `serverid(toolname)` → pass through
   * - Regular tools: filter read-only, pass through others
   *
   * @param pattern Tool pattern from user config
   * @returns Converted pattern, or null if should be filtered
   */
  private convertToCopilotFormat(pattern: string): string | null {
    // Convert Claude-format MCP tool patterns to Copilot format.
    // Claude uses `mcp__<serverId>__<toolName>`; Copilot uses `serverId(toolName)`.
    const mcpConverted = this.convertMcpPattern(pattern);
    if (mcpConverted !== null) {
      return mcpConverted;
    }

    // Parse pattern to extract tool name
    const parsed = this.parsePattern(pattern);
    if (!parsed) {
      Log.warn(
        `[CopilotToolPermissionMapper] Invalid tool pattern: ${pattern}`
      );
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
   * Convert a Claude-format MCP pattern (`mcp__<serverId>__<toolName>`)
   * to Copilot format (`serverId(toolName)`).
   * Returns null if the pattern is not in Claude MCP format.
   */
  private convertMcpPattern(pattern: string): string | null {
    if (!pattern.startsWith("mcp__")) return null;
    const rest = pattern.slice(5); // Remove "mcp__" prefix
    const sepIdx = rest.indexOf("__");
    if (sepIdx < 1) return null; // Need at least one char for serverId
    const serverId = rest.slice(0, sepIdx);
    const toolName = rest.slice(sepIdx + 2);
    if (!serverId || !toolName) return null;
    return CopilotToolPermissionMapper.toCopilotMcpToolPattern(
      serverId,
      toolName
    );
  }
}
