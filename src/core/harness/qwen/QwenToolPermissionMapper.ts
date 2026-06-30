import {
  IToolPermissionMapper,
  ToolPermissionMapperBase,
  ToolPermissionConfig,
} from "../shared/interfaces/IToolPermissionMapper";
import { Log } from "../../../utils/Log";
import { PERMISSION_MODES } from "../../../types/DashboardConstants";

/**
 * Qwen Code CLI Tool Permission Mapper
 *
 * Converts ctrlyoke's unified permission configuration to Qwen CLI arguments.
 *
 * **Key Difference:** Qwen uses **mode-based** permissions, not pattern-based like Claude/Copilot.
 *
 * | ctrlyoke Setting | Qwen Mapping |
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
   * Converts ctrlyoke permission config to Qwen CLI arguments.
   *
   * @param config Tool permission configuration
   * @returns CLI arguments array
   */
  buildArgs(config: ToolPermissionConfig): string[] {
    const args: string[] = [];

    Log.debug(
      `[QwenPermissionMapper] Building args: mode=${config.mode}, allowed=${config.allowedTools.length}, denied=${config.deniedTools.length}`
    );

    if (config.mode === PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL) {
      // YOLO mode - bypass all approval prompts and tool restrictions.
      // Consistent with all other harnesses: dangerouslyAllowAll means everything
      // is permitted, including ignored deny lists. If Qwen enforces deny rules
      // in YOLO mode that is a Qwen bug, not something ctrlyoke works around.
      args.push("-y");
      Log.debug("🔓 Qwen YOLO mode enabled (dangerouslyAllowAll)");
    } else if (config.mode === PERMISSION_MODES.ALLOW_ALL) {
      // Auto-approve most operations but still respect deny lists.
      args.push("--approval-mode", "auto-edit");
      Log.debug("✅ Qwen auto-edit mode enabled (allowAll)");

      // Denied tools apply in allowAll mode (e.g. MCP tool filtering during
      // commit message generation: mcp__ctrlyoke-commit__*).
      if (config.deniedTools.length > 0) {
        const deniedArgs = this.convertCtrlYokePatternsToQwenTools(
          config.deniedTools
        );
        if (deniedArgs.length > 0) {
          args.push("--exclude-tools", deniedArgs.join(","));
          Log.debug(`🚫 Qwen excluded tools: ${deniedArgs.join(", ")}`);
        }
      }
    } else {
      // Custom mode - use default approval with allow/deny lists
      args.push("--approval-mode", "default");
      Log.debug("🔧 Qwen default approval mode (custom)");

      // Add allowed tools if specified
      if (config.allowedTools.length > 0) {
        const allowedArgs = this.convertCtrlYokePatternsToQwenTools(
          config.allowedTools
        );
        if (allowedArgs.length > 0) {
          args.push("--allowed-tools", allowedArgs.join(","));
          Log.debug(`📋 Qwen allowed tools: ${allowedArgs.join(", ")}`);
        }
      }

      // Add denied tools if specified (takes precedence over allowed)
      if (config.deniedTools.length > 0) {
        const deniedArgs = this.convertCtrlYokePatternsToQwenTools(
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
   * Convert ctrlyoke tool patterns to Qwen tool specifiers.
   *
   * ctrlyoke uses patterns like "shell(git:*)" which need to be
   * converted to Qwen's tool specifier format.
   *
   * Qwen supports sub-command filtering with the same parentheses syntax as
   * Claude Code, but uses a space instead of a colon as the command/args separator:
   *   ctrlyoke: shell(rm:*)      → Qwen: Bash(rm *)
   *   ctrlyoke: shell(git:*)     → Qwen: Bash(git *)
   *   ctrlyoke: shell            → Qwen: Bash          (block all shell)
   *
   * MCP tools support server-level wildcards:
   *   mcp__servername              → matches all tools from that server
   *   mcp__servername__toolname    → matches one specific tool
   *
   * Deduplicates via Set so multiple shell(X:*) patterns mapping to the same
   * Qwen specifier don't produce repeated entries (e.g. Bash,Bash,Bash).
   *
   * @param patterns ctrlyoke tool patterns
   * @returns Qwen tool specifiers array (deduplicated)
   */
  private convertCtrlYokePatternsToQwenTools(patterns: string[]): string[] {
    const qwenTools = new Set<string>();

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

      if (
        normalizedToolName === "shell" ||
        normalizedToolName === "bash" ||
        normalizedToolName === "run_shell_command"
      ) {
        qwenTools.add(this.buildQwenShellSpec("Bash", toolArgs));
      } else if (
        normalizedToolName === "write" ||
        normalizedToolName === "create"
      ) {
        qwenTools.add("Write");
      } else if (normalizedToolName === "read") {
        qwenTools.add("Read");
      } else if (
        normalizedToolName === "edit" ||
        normalizedToolName === "str_replace"
      ) {
        qwenTools.add("Edit");
      } else if (
        normalizedToolName === "delete" ||
        normalizedToolName === "remove"
      ) {
        qwenTools.add("Delete");
      } else if (
        normalizedToolName === "web_search" ||
        normalizedToolName === "search" ||
        normalizedToolName === "web_fetch"
      ) {
        qwenTools.add("WebFetch");
      } else if (normalizedToolName === "mcp") {
        // MCP tools: preserve full pattern for server-level or tool-level matching.
        // Qwen supports: mcp__server (all tools) and mcp__server__tool (specific).
        if (toolArgs) {
          qwenTools.add(`mcp__${toolArgs.replace(/[()]/g, "")}`);
        }
      } else {
        // Unknown tool - pass through as-is
        qwenTools.add(toolName);
      }
    }

    return [...qwenTools];
  }

  /**
   * Convert a ctrlyoke shell pattern to a Qwen Bash specifier.
   *
   * Qwen uses a space between command and argument glob (Bash(rm *)), while
   * ctrlyoke uses a colon (shell(rm:*)). A bare "shell"/"shell(*)"/"shell(*:*)"
   * with no specific command means "block all shell" → plain "Bash".
   *
   * @param qwenToolName The Qwen tool name (e.g. "Bash")
   * @param toolArgs Raw args from parsePattern, including parentheses (e.g. "(rm:*)")
   * @returns Qwen specifier string (e.g. "Bash(rm *)" or "Bash")
   */
  private buildQwenShellSpec(qwenToolName: string, toolArgs: string): string {
    if (!toolArgs) {
      return qwenToolName;
    }

    // Strip surrounding parens: "(rm:*)" → "rm:*"
    const inner = toolArgs.replace(/^\(|\)$/g, "");

    // Pure wildcards mean "all commands" — emit the bare tool name
    if (!inner || inner === "*" || inner === "*:*") {
      return qwenToolName;
    }

    const colonIdx = inner.indexOf(":");
    if (colonIdx === -1) {
      // No colon: treat entire inner as command name (e.g. shell(npm) → Bash(npm *))
      return `${qwenToolName}(${inner} *)`;
    }

    const command = inner.substring(0, colonIdx);
    const argPattern = inner.substring(colonIdx + 1);

    // Wildcard command with specific args is still effectively "all commands" → bare tool
    if (!command || command === "*") {
      return qwenToolName;
    }

    if (!argPattern || argPattern === "*") {
      // "command with any args" → Bash(command *)
      return `${qwenToolName}(${command} *)`;
    }

    // Specific command + specific arg pattern → Bash(command argPattern)
    return `${qwenToolName}(${command} ${argPattern})`;
  }
}
