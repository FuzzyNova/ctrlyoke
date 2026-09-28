// Re-export for consumers that import from this file
export type {
  ToolPermissionMode,
  ToolPermissionConfig,
} from "./interfaces/IToolPermissionMapper";

/**
 * Maps Copilot permission names to Claude tool names.
 *
 * Single source of truth shared with ClaudeToolPermissionMapper.
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
