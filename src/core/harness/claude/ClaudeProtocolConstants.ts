/** Wire-level values shared by Claude's Anthropic message and content blocks. */
export const CLAUDE_EVENT_TYPES = {
  USER: "user",
  ASSISTANT: "assistant",
} as const;

export const CLAUDE_CONTENT_BLOCK_TYPES = {
  TEXT: "text",
  TOOL_USE: "tool_use",
} as const;

export const CLAUDE_STOP_REASONS = {
  TOOL_USE: "tool_use",
} as const;
