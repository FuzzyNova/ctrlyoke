/** Wire-level values shared by Claude's Anthropic message and content blocks. */
export const CLAUDE_EVENT_TYPES = {
  USER: "user",
  ASSISTANT: "assistant",
  SYSTEM: "system",
  RESULT: "result",
  PROGRESS: "progress",
} as const;

export const CLAUDE_CONTENT_BLOCK_TYPES = {
  TEXT: "text",
  TOOL_USE: "tool_use",
  THINKING: "thinking",
  TOOL_RESULT: "tool_result",
} as const;

export const CLAUDE_SYSTEM_SUBTYPES = {
  INIT: "init",
  TURN_DURATION: "turn_duration",
  COMPACT_BOUNDARY: "compact_boundary",
} as const;

export const CLAUDE_PROGRESS_TYPES = {
  BASH: "bash_progress",
} as const;

export const CLAUDE_TOOL_RESULT_TYPES = {
  CREATE: "create",
} as const;

export const CLAUDE_HOOK_CONFIG_TYPES = {
  JSON_STRING: "json-string",
} as const;

export const CLAUDE_STOP_REASONS = {
  TOOL_USE: "tool_use",
} as const;
