import { Log } from "../../../utils/Log";
import {
  inspectToolPatternSyntax,
  parseToolPattern,
} from "../../../utils/ToolPatternSyntax";
import {
  ToolPermissionMode,
  ToolPermissionConfig,
} from "./interfaces/IToolPermissionMapper";

// Re-export for consumers that import from this file
export type { ToolPermissionMode, ToolPermissionConfig };

/**
 * Maps Copilot permission patterns to Claude tool names
 *
 * Single source of truth: also used by ClaudeToolPermissionMapper
 */
export const COPILOT_TO_CLAUDE_MAP: Record<string, string> = {
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
    return parseToolPattern(pattern);
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

  // Harness-specific preparation lives in each mapper's prepare() method.

  /**
   * Validate tool patterns for syntax errors.
   *
   * Checks for common pattern mistakes (unclosed parentheses, misplaced wildcards)
   * and logs each warning via `Log.warn()`. Returns the same warnings as an array
   * so callers can programmatically inspect them.
   *
   * @param patterns - Tool patterns to validate
   * @returns Array of warning messages (empty if all patterns are valid)
   */
  static validatePatterns(patterns: string[]): string[] {
    const warnings: string[] = [];

    for (const pattern of patterns) {
      const syntax = inspectToolPatternSyntax(pattern);
      if (syntax.doesNotMatchPattern && !syntax.hasOpeningParenthesis) {
        // If it doesn't parse and doesn't have parentheses, might be invalid
        // But allow MCP server names without parentheses
        continue;
      }

      // Check for common mistakes
      if (syntax.hasWildcardOutsideParentheses) {
        warnings.push(
          `Pattern "${pattern}" contains wildcard (*) but missing argument parentheses. Did you mean "${pattern.replace("*", "(*)")}?`
        );
      }

      if (syntax.hasUnclosedParentheses) {
        warnings.push(`Pattern "${pattern}" has unclosed parentheses`);
      }
    }

    for (const warning of warnings) {
      Log.warn(`[CliToolPermissionMapper] ${warning}`);
    }

    return warnings;
  }
}
