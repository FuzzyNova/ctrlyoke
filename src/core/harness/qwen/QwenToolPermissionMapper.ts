import {
  IToolPermissionMapper,
  PermissionContext,
  ToolPermissionMapperBase,
  ToolPermissionConfig,
  ToolPermissionApplication,
} from "../shared/interfaces/IToolPermissionMapper";
import type { PermissionCapabilityDescriptor } from "../../../types/CompatibilityTypes";
import { Log } from "../../../utils/Log";
import {
  HARNESS_IDS,
  PERMISSION_MODES,
  TOOL_PERMISSION_CATEGORIES,
} from "../../../types/DashboardConstants";

const QWEN_PERMISSION_VERIFICATION = {
  kind: "behavioral-test",
  reference: "src/test/harness/inline-config.harness.test.ts",
  basis: "cli-version",
  verifiedVersions: [">=0.20.1"],
} as const;

const QWEN_PERMISSION_TOOL_NAMES = {
  DELETE: "delete",
  SEARCH: "search",
} as const;

const QWEN_PERMISSION_CAPABILITIES: PermissionCapabilityDescriptor = {
  mode: {
    fidelity: "exact",
    mechanism: "translated-cli",
    verification: QWEN_PERMISSION_VERIFICATION,
  },
  allowedTools: {
    fidelity: "exact",
    mechanism: "translated-cli",
    verification: QWEN_PERMISSION_VERIFICATION,
  },
  deniedTools: {
    fidelity: "exact",
    mechanism: "translated-cli",
    verification: QWEN_PERMISSION_VERIFICATION,
  },
};

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
  readonly capabilities = QWEN_PERMISSION_CAPABILITIES;

  /**
   * Build CLI arguments for tool permissions
   *
   * Converts ctrlyoke permission config to Qwen CLI arguments.
   *
   * @param config Tool permission configuration
   * @returns CLI arguments array
   */
  async prepare(
    config: ToolPermissionConfig,
    _context: PermissionContext
  ): Promise<ToolPermissionApplication> {
    const args: string[] = [];
    const lossyPatterns: { capability: "allowedTools" | "deniedTools" }[] = [];

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
          config.deniedTools,
          () => lossyPatterns.push({ capability: "deniedTools" })
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
          config.allowedTools,
          () => lossyPatterns.push({ capability: "allowedTools" })
        );
        if (allowedArgs.length > 0) {
          args.push("--allowed-tools", allowedArgs.join(","));
          Log.debug(`📋 Qwen allowed tools: ${allowedArgs.join(", ")}`);
        }
      }

      // Add denied tools if specified (takes precedence over allowed)
      if (config.deniedTools.length > 0) {
        const deniedArgs = this.convertCtrlYokePatternsToQwenTools(
          config.deniedTools,
          () => lossyPatterns.push({ capability: "deniedTools" })
        );
        if (deniedArgs.length > 0) {
          args.push("--exclude-tools", deniedArgs.join(","));
          Log.debug(`🚫 Qwen excluded tools: ${deniedArgs.join(", ")}`);
        }
      }
    }

    return {
      cliArgs: args,
      diagnostics: [
        ...this.getToolTranslationDiagnostics(config, HARNESS_IDS.QWEN_CLI),
        ...lossyPatterns.map(({ capability }) =>
          this.createLossyTranslationDiagnostic(
            HARNESS_IDS.QWEN_CLI,
            capability
          )
        ),
      ],
    };
  }

  /**
   * Convert ctrlyoke tool patterns to Qwen tool specifiers.
   *
   * ctrlyoke uses patterns like "shell(git:*)" which need to be
   * converted to Qwen's tool specifier format.
   *
   * Qwen supports sub-command filtering with the same parentheses syntax as
   * Claude Code, but uses a space instead of a colon as the command/args separator:
   *   ctrlyoke: shell(rm:*)      → Qwen: ShellTool(rm *)
   *   ctrlyoke: shell(git:*)     → Qwen: ShellTool(git *)
   *   ctrlyoke: shell            → Qwen: ShellTool          (block all shell)
   *
   * MCP tools support server-level wildcards:
   *   mcp__servername              → matches all tools from that server
   *   mcp__servername__toolname    → matches one specific tool
   *
   * Uses "ShellTool"/"WriteFile" rather than Claude-style "Bash"/"Write": both
   * spellings resolve to the same Qwen tool via its current alias table, but
   * only the former is also recognized by an older, narrower alias table Qwen
   * still consults on some code paths — see the Root Cause section of
   * dev/implemented/TOOL_PERMISSION_PARITY_PLAN.md for the silent-deny bug this
   * avoids.
   *
   * Deduplicates via Set so multiple shell(X:*) patterns mapping to the same
   * Qwen specifier don't produce repeated entries (e.g. ShellTool,ShellTool).
   *
   * `delete`/`remove` patterns are skipped (with a warning), not mapped: Qwen
   * has no dedicated file-delete tool, so there is no specifier that would
   * make such a rule actually take effect. File deletion on Qwen goes through
   * ShellTool(rm ...) and must be governed by a shell(rm:*) rule instead.
   *
   * @param patterns ctrlyoke tool patterns
   * @returns Qwen tool specifiers array (deduplicated)
   */
  private convertCtrlYokePatternsToQwenTools(
    patterns: string[],
    onLossyPattern?: () => void
  ): string[] {
    const qwenTools = new Set<string>();

    for (const pattern of patterns) {
      const parsed = this.parsePattern(pattern);
      if (!parsed) {
        onLossyPattern?.();
        Log.warn(
          `[QwenPermissionMapper] Invalid tool pattern: ${pattern}, skipping`
        );
        continue;
      }

      const [toolName, toolArgs] = parsed;
      const normalizedToolName = toolName.toLowerCase();

      if (
        normalizedToolName === TOOL_PERMISSION_CATEGORIES.SHELL ||
        normalizedToolName === TOOL_PERMISSION_CATEGORIES.BASH ||
        normalizedToolName === "run_shell_command"
      ) {
        qwenTools.add(this.buildQwenShellSpec("ShellTool", toolArgs));
      } else if (
        normalizedToolName === TOOL_PERMISSION_CATEGORIES.WRITE ||
        normalizedToolName === "create"
      ) {
        qwenTools.add("WriteFile");
      } else if (normalizedToolName === TOOL_PERMISSION_CATEGORIES.READ) {
        qwenTools.add("Read");
      } else if (
        normalizedToolName === TOOL_PERMISSION_CATEGORIES.EDIT ||
        normalizedToolName === "str_replace"
      ) {
        qwenTools.add("Edit");
      } else if (
        normalizedToolName === QWEN_PERMISSION_TOOL_NAMES.DELETE ||
        normalizedToolName === "remove"
      ) {
        // Qwen has no dedicated file-delete tool (confirmed against its full
        // TOOL_NAME_ALIASES registry — shell/edit/write/read/grep/glob/
        // list_directory/todo/webfetch/websearch/mcp/agent/skill/plan-mode/
        // lsp/monitor are the complete set). Qwen deletes files via
        // ShellTool(rm ...), so a ctrlyoke delete/remove rule has no faithful
        // Qwen equivalent — emitting a literal "Delete" specifier would
        // silently match nothing and create a false sense of enforcement.
        // Skip it and warn instead of emitting a dead specifier.
        Log.warn(
          `[QwenPermissionMapper] Qwen has no delete/remove tool equivalent; pattern "${pattern}" has no effect and was skipped. Use a shell(rm:*) rule to control file deletion on Qwen.`
        );
        onLossyPattern?.();
      } else if (
        normalizedToolName === "web_search" ||
        normalizedToolName === QWEN_PERMISSION_TOOL_NAMES.SEARCH ||
        normalizedToolName === "web_fetch"
      ) {
        qwenTools.add("WebFetch");
      } else if (normalizedToolName === TOOL_PERMISSION_CATEGORIES.MCP) {
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
   * Convert a ctrlyoke shell pattern to a Qwen ShellTool specifier.
   *
   * Qwen uses a space between command and argument glob (ShellTool(rm *)), while
   * ctrlyoke uses a colon (shell(rm:*)). A bare "shell"/"shell(*)"/"shell(*:*)"
   * with no specific command means "block all shell" → plain "ShellTool".
   *
   * @param qwenToolName The Qwen tool name (e.g. "ShellTool")
   * @param toolArgs Raw args from parsePattern, including parentheses (e.g. "(rm:*)")
   * @returns Qwen specifier string (e.g. "ShellTool(rm *)" or "ShellTool")
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
      // No colon: treat entire inner as command name (e.g. shell(npm) → ShellTool(npm *))
      return `${qwenToolName}(${inner} *)`;
    }

    const command = inner.substring(0, colonIdx);
    const argPattern = inner.substring(colonIdx + 1);

    // Wildcard command with specific args is still effectively "all commands" → bare tool
    if (!command || command === "*") {
      return qwenToolName;
    }

    if (!argPattern || argPattern === "*") {
      // "command with any args" → ShellTool(command *)
      return `${qwenToolName}(${command} *)`;
    }

    // Specific command + specific arg pattern → ShellTool(command argPattern)
    return `${qwenToolName}(${command} ${argPattern})`;
  }
}
