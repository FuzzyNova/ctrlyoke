import { Log } from "../../../utils/Log";

/**
 * Tool permission mode
 */
export type ToolPermissionMode = "dangerouslyAllowAll" | "allowAll" | "custom";

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
 * Maps Claude tool names to Copilot permission categories
 * Read-only tools map to null (no Copilot permission needed)
 */
const CLAUDE_TO_COPILOT_MAP: Record<string, string | null> = {
  bash: "shell",
  write: "write",
  edit: "write",
  multiedit: "write",
  // Read-only tools - no Copilot permission needed
  read: null,
  glob: null,
  grep: null,
  ls: null,
  webfetch: null,
  todowrite: null,
};

/**
 * Tool permission configuration
 */
export interface ToolPermissionConfig {
  mode: ToolPermissionMode;
  allowedTools: string[];
  deniedTools: string[];
}

/**
 * Shared tool permission pattern conversion and argument generation
 *
 * Handles:
 * - Bidirectional conversion (Copilot ↔ Claude tool patterns)
 * - CLI-specific argument formatting
 * - Mode-based permissions (dangerouslyAllowAll, allowAll, custom)
 * - Read-only tool filtering (for Copilot)
 *
 * NOTE: Codex CLI does NOT support granular tool patterns.
 * For Codex, use mode-based permissions only.
 */
export class CliToolPermissionMapper {
  /**
   * Parse a tool pattern into tool name and optional arguments
   *
   * Examples:
   * - "shell(git:*)" → ["shell", "(git:*)"]
   * - "Write" → ["Write", ""]
   * - "github(search)" → ["github", "(search)"]
   *
   * @param pattern Tool pattern string
   * @returns [toolName, args] or null if pattern doesn't match expected format
   */
  static parsePattern(pattern: string): [string, string] | null {
    const match = pattern.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)(\(.*\))?$/);
    if (!match) {
      return null;
    }

    return [match[1], match[2] || ""];
  }

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
  static convertToClaudeFormat(copilotPattern: string): string {
    const parsed = this.parsePattern(copilotPattern);
    if (!parsed) {
      return copilotPattern; // Keep as-is if pattern doesn't match
    }

    const [toolName, args] = parsed;
    const claudeToolName =
      COPILOT_TO_CLAUDE_MAP[toolName.toLowerCase()] || toolName;
    return args ? claudeToolName + args : claudeToolName;
  }

  /**
   * Convert Claude tool pattern to Copilot format
   *
   * Returns null if tool should be filtered out (read-only tools).
   *
   * Examples:
   * - "Bash(git:*)" → "shell(git:*)"
   * - "Write" → "write"
   * - "Edit" → "write" (closest equivalent)
   * - "Read" → null (no Copilot permission needed, filter out)
   * - "github(search)" → "github(search)" (MCP tools pass through)
   *
   * @param claudePattern Claude tool pattern
   * @returns Copilot permission pattern or null to filter out
   */
  static convertToCopilotFormat(claudePattern: string): string | null {
    const parsed = this.parsePattern(claudePattern);
    if (!parsed) {
      return claudePattern; // Return as-is (e.g., MCP tools)
    }

    const [toolName, args] = parsed;
    const lowerToolName = toolName.toLowerCase();

    // Check if this is a Claude tool that needs conversion
    if (lowerToolName in CLAUDE_TO_COPILOT_MAP) {
      const copilotTool = CLAUDE_TO_COPILOT_MAP[lowerToolName];
      if (copilotTool === null) {
        // Tool has no Copilot equivalent, filter it out
        return null;
      }
      return args ? copilotTool + args : copilotTool;
    }

    // Not a Claude tool, pass through as-is (could be shell, write, or MCP tool)
    return claudePattern;
  }

  /**
   * Build Claude CLI permission arguments
   *
   * Modes:
   * - dangerouslyAllowAll: --dangerously-skip-permissions (bypasses ALL checks, ignores deny list)
   * - allowAll: --permission-mode bypassPermissions + --tools "default" (auto-grants all, respects deny list)
   * - custom: --permission-mode bypassPermissions + --allowedTools/--disallowedTools patterns
   *
   * @param config Tool permission configuration
   * @returns CLI arguments array
   */
  static buildClaudeArgs(config: ToolPermissionConfig): string[] {
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
   * Build Copilot CLI permission arguments
   *
   * Modes:
   * - dangerouslyAllowAll: --allow-all-tools with NO deny patterns
   * - allowAll: --allow-all-tools with deny patterns (recommended)
   * - custom: Specific --allow-tool patterns with deny patterns
   *
   * @param config Tool permission configuration
   * @returns CLI arguments array
   */
  static buildCopilotArgs(config: ToolPermissionConfig): string[] {
    const args: string[] = [];
    const filteredTools: string[] = [];

    // Add allow mode first
    if (
      config.mode === "dangerouslyAllowAll" ||
      config.mode === "allowAll"
    ) {
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
   * Build Codex CLI permission arguments
   *
   * WARNING: Codex does NOT support granular tool patterns.
   * If tool patterns are configured, this logs a warning.
   *
   * Modes:
   * - dangerouslyAllowAll: --dangerously-bypass-approvals-and-sandbox
   * - allowAll: --full-auto
   * - custom: Uses Codex-specific sandbox and approval settings (from ConfigurationUtils)
   *
   * @param config Tool permission configuration
   * @param sandboxMode Codex sandbox mode (for custom mode)
   * @param approvalPolicy Codex approval policy (for custom mode)
   * @returns CLI arguments array
   */
  static buildCodexArgs(
    config: ToolPermissionConfig,
    sandboxMode?: string,
    approvalPolicy?: string
  ): string[] {
    // Warn if tool patterns are configured (unsupported by Codex)
    if (config.allowedTools.length > 0 || config.deniedTools.length > 0) {
      Log.warn(
        "⚠️ Codex CLI does not support granular tool patterns (cliAllowedTools/cliDeniedTools). Use Codex-specific sandbox/approval settings for custom control."
      );
    }

    switch (config.mode) {
      case "dangerouslyAllowAll":
        // Bypass ALL checks (dangerous!)
        return ["--dangerously-bypass-approvals-and-sandbox"];

      case "allowAll":
        // Safe automation: auto-grant all but respect deny list
        return ["--full-auto"];

      case "custom":
        // Use Codex-specific sandbox and approval settings
        // Note: --add-dir is handled elsewhere, not here
        if (sandboxMode && approvalPolicy) {
          return ["-s", sandboxMode, "-a", approvalPolicy];
        } else {
          Log.warn(
            "⚠️ Custom mode requires sandboxMode and approvalPolicy for Codex. Falling back to --full-auto."
          );
          return ["--full-auto"];
        }

      default:
        return ["--full-auto"];
    }
  }

  /**
   * Validate tool patterns for syntax errors
   *
   * @param patterns Tool patterns to validate
   * @returns Array of validation errors (empty if valid)
   */
  static validatePatterns(patterns: string[]): string[] {
    const errors: string[] = [];

    for (const pattern of patterns) {
      const parsed = this.parsePattern(pattern);
      if (!parsed && !pattern.includes("(")) {
        // If it doesn't parse and doesn't have parentheses, might be invalid
        // But allow MCP server names without parentheses
        continue;
      }

      // Check for common mistakes
      if (pattern.includes("*") && !pattern.includes("(")) {
        errors.push(
          `Pattern "${pattern}" contains wildcard (*) but missing argument parentheses. Did you mean "${pattern.replace("*", "(*)")}?`
        );
      }

      if (pattern.includes("(") && !pattern.includes(")")) {
        errors.push(`Pattern "${pattern}" has unclosed parentheses`);
      }
    }

    return errors;
  }
}
