import { parseToolPattern } from "../../../utils/ToolPatternSyntax";
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
 * Shared permission pattern parsing for harness-specific argument generation.
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
}
