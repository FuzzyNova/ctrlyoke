import {
  IToolPermissionMapper,
  PermissionContext,
  ToolPermissionConfig,
  ToolPermissionMapperBase,
  ToolPermissionApplication,
} from "../shared/interfaces/IToolPermissionMapper";
import {
  PERMISSION_CAVEAT_CODES,
  capabilitySuiteVerification,
  type PermissionCapabilityDescriptor,
} from "../../../types/CompatibilityTypes";
import { COPILOT_TO_CLAUDE_MAP } from "../shared/CliToolPermissionMapper";
import { Log } from "../../../utils/Log";
import {
  HARNESS_IDS,
  PERMISSION_MODES,
} from "../../../types/DashboardConstants";

const CLAUDE_PERMISSION_VERIFICATION = capabilitySuiteVerification([
  ">=2.1.17",
]);

const CLAUDE_PERMISSION_CAPABILITIES: PermissionCapabilityDescriptor = {
  mode: {
    fidelity: "exact",
    mechanism: "native",
    verification: CLAUDE_PERMISSION_VERIFICATION,
  },
  allowedTools: {
    fidelity: "partial",
    mechanism: "translated-cli",
    verification: CLAUDE_PERMISSION_VERIFICATION,
    caveatCode: PERMISSION_CAVEAT_CODES.CLAUDE_PREAPPROVED_SETTINGS,
  },
  deniedTools: {
    fidelity: "exact",
    mechanism: "translated-cli",
    verification: CLAUDE_PERMISSION_VERIFICATION,
  },
};

/**
 * Claude CLI Tool Permission Mapper
 *
 * Converts ctrlyoke's unified tool permission configuration into
 * Claude CLI arguments.
 *
 * Permission modes:
 * - dangerouslyAllowAll: --dangerously-skip-permissions (bypasses ALL checks)
 * - allowAll: --permission-mode bypassPermissions --tools "default" (respects deny list)
 * - custom: --permission-mode dontAsk headless, --permission-mode default interactive.
 *   Both apply --allowedTools and --disallowedTools.
 *
 * Tool name conversion:
 * - Copilot format: shell(git:*), write
 * - Claude format: Bash(git:*), Write
 * - Mapping: shell → Bash, write → Write
 * - MCP tools pass through unchanged
 *
 * Claude CLI specifics:
 * - Uses --permission-mode bypassPermissions for allowAll
 * - Uses --permission-mode dontAsk for headless custom runs, which deny tools
 *   that are not pre-approved; interactive custom runs use the default (prompting) mode
 * - Uses --tools "default" for all default tools
 * - Uses --allowedTools for specific tools
 * - Uses --disallowedTools for deny patterns
 * - Tool names are case-sensitive (Bash, Write, not bash, write)
 */
export class ClaudeToolPermissionMapper
  extends ToolPermissionMapperBase
  implements IToolPermissionMapper
{
  readonly capabilities = CLAUDE_PERMISSION_CAPABILITIES;

  /**
   * Build CLI arguments for tool permissions
   *
   * @param config Tool permission configuration
   * @returns CLI arguments array
   */
  async prepare(
    config: ToolPermissionConfig,
    context: PermissionContext
  ): Promise<ToolPermissionApplication> {
    if (config.mode === PERMISSION_MODES.NONE) {
      return { cliArgs: [], diagnostics: [] };
    }
    let args: string[];
    if (config.mode === PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL) {
      args = ["--dangerously-skip-permissions"];
    } else {
      if (config.mode === PERMISSION_MODES.ALLOW_ALL) {
        // Keep allowAll behavior unchanged.
        args = ["--permission-mode", "bypassPermissions"];
        args.push("--tools", "default");
      } else {
        // In headless mode dontAsk auto-denies tools that are not pre-approved.
        // Interactive mode prompts for them. It is named explicitly: left
        // out, Claude would use the user's own `defaultMode`, and a default of
        // bypassPermissions or acceptEdits would never ask.
        args = [
          "--permission-mode",
          context.isInteractive ? "default" : "dontAsk",
        ];
        const convertedAllowTools = this.convertUnique(
          config.allowedTools,
          (t) => this.convertToClaudeFormat(t)
        );
        if (convertedAllowTools.length > 0) {
          args.push("--allowedTools", ...convertedAllowTools);
          Log.debug(
            `[ClaudeToolPermissionMapper] Allowed tools: ${convertedAllowTools.join(", ")}`
          );
        }
      }

      const convertedDenyTools = this.convertUnique(config.deniedTools, (t) =>
        this.convertToClaudeFormat(t)
      );
      if (convertedDenyTools.length > 0) {
        args.push("--disallowedTools", ...convertedDenyTools);
        Log.debug(
          `[ClaudeToolPermissionMapper] Denied tools: ${convertedDenyTools.join(", ")}`
        );
      }
    }
    return {
      cliArgs: args,
      diagnostics: this.getToolTranslationDiagnostics(
        config,
        HARNESS_IDS.CLAUDE_CLI
      ),
    };
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
