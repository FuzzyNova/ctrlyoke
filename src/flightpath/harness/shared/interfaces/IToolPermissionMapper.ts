/**
 * Tool permission mode
 */
export type ToolPermissionMode = "dangerouslyAllowAll" | "allowAll" | "custom";

/**
 * Tool permission configuration
 */
export interface ToolPermissionConfig {
  /** Permission mode */
  mode: ToolPermissionMode;

  /** Allowed tool patterns (used in custom mode) */
  allowedTools: string[];

  /** Denied tool patterns (takes precedence over allowed) */
  deniedTools: string[];
}

/**
 * Tool permission mapper interface
 *
 * Each CLI harness implements this to convert FlightPath's unified permission
 * configuration into their specific CLI arguments.
 *
 * Example conversions:
 * - Copilot: `shell(git:*)` → `--allow-tools shell(git:*)`
 * - Claude: `shell(git:*)` → `--tools "default"` (plus deny list)
 * - Codex: `shell(git:*)` → MCP tool configuration
 */
export interface IToolPermissionMapper {
  /**
   * Build CLI arguments for tool permissions
   * @param config Tool permission configuration
   * @returns CLI arguments array
   */
  buildArgs(config: ToolPermissionConfig): string[];

  /**
   * Check if full permissions are granted (no prompts will occur)
   * @param config Tool permission configuration
   * @returns True if all permissions auto-granted
   */
  hasFullPermissions(config: ToolPermissionConfig): boolean;
}

/**
 * Shared utilities for tool permission mappers (optional base class)
 *
 * Provides common pattern parsing and validation utilities.
 * Providers can extend this class to avoid duplicating logic.
 */
export abstract class ToolPermissionMapperBase implements IToolPermissionMapper {
  abstract buildArgs(config: ToolPermissionConfig): string[];
  abstract hasFullPermissions(config: ToolPermissionConfig): boolean;

  /**
   * Parse a tool pattern into name and arguments
   * @param pattern Tool pattern string (e.g., "shell(git:*)")
   * @returns [toolName, args] or null if invalid
   *
   * @example
   * parsePattern("shell(git:*)") → ["shell", "(git:*)"]
   * parsePattern("write") → ["write", ""]
   * parsePattern("invalid-pattern!") → null
   */
  protected parsePattern(pattern: string): [string, string] | null {
    const match = pattern.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)(\(.*\))?$/);
    if (!match) {
      return null;
    }
    return [match[1], match[2] || ""];
  }

  /**
   * Check if a pattern matches any in a list
   * @param pattern Pattern to check
   * @param patterns List of patterns to match against
   * @returns True if pattern matches any in the list
   */
  protected matchesAnyPattern(pattern: string, patterns: string[]): boolean {
    const parsed = this.parsePattern(pattern);
    if (!parsed) {
      return false;
    }

    const [toolName, toolArgs] = parsed;

    for (const p of patterns) {
      const parsedP = this.parsePattern(p);
      if (!parsedP) {
        continue;
      }

      const [pName, pArgs] = parsedP;

      // Exact tool name match
      if (toolName !== pName) {
        continue;
      }

      // No args specified = match any args
      if (!pArgs) {
        return true;
      }

      // Exact args match or wildcard
      if (toolArgs === pArgs || pArgs === "(*)") {
        return true;
      }

      // Partial wildcard match (e.g., "git:*" matches "git:push")
      if (pArgs.includes("*")) {
        const regex = new RegExp(
          "^" +
            pArgs
              .replace(/\*/g, ".*")
              .replace(/\(/g, "\\(")
              .replace(/\)/g, "\\)") +
            "$"
        );
        if (regex.test(toolArgs)) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Validate tool pattern format
   * @param pattern Tool pattern to validate
   * @returns True if pattern is valid
   */
  protected isValidPattern(pattern: string): boolean {
    return this.parsePattern(pattern) !== null;
  }

  /**
   * Normalize tool name (convert to lowercase)
   * @param toolName Tool name
   * @returns Normalized tool name
   */
  protected normalizeTool(toolName: string): string {
    return toolName.toLowerCase();
  }
}
