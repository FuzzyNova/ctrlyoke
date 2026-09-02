/** Wire-level message event types from Qwen's Gemini-style log protocol. */
export const QWEN_EVENT_TYPES = {
  USER: "user",
  ASSISTANT: "assistant",
  TOOL_RESULT: "tool_result",
  RESULT: "result",
} as const;

export const QWEN_CONTENT_PART_TYPES = {
  TEXT: "text",
  TOOL_USE: "tool_use",
  THINKING: "thinking",
} as const;
