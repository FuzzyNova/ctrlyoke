/** Wire-level values from OpenCode's exported message/part protocol. */
export const OPENCODE_MESSAGE_ROLES = {
  USER: "user",
  ASSISTANT: "assistant",
} as const;

export const OPENCODE_EVENT_TYPES = {
  TEXT: "text",
  TOOL_USE: "tool_use",
  USER_TEXT: "user_text",
} as const;
